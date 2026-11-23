import { randomUUID } from "node:crypto";
import { database, atomic } from "../src/server/database";
import { authentication } from "../src/server/auth";
import {
  createAcademy,
  context,
  saveRecord,
  approveReport,
} from "../src/server/workspace-service";
import { trainingAction } from "../src/server/training-service";
import { financeAction } from "../src/server/finance-service";
import type { WorkspaceAccess } from "../src/server/workspace-access";
import type {
  WorkspacePlayer,
  WorkspaceDrill,
  WorkspacePlan,
  WorkspaceReport,
} from "../src/domain/workspace";
import type {
  FootballSession,
  FootballSquad,
  FootballVenue,
} from "../src/domain/training";

async function main() {
  console.log("=== Starting Summit Football Academy Seeding ===");
  const auth = await authentication();

  // Helper to create or fetch account
  async function getOrCreateAccount(name: string, email: string, pass: string) {
    try {
      const res = await auth.api.signUpEmail({
        body: { name, email, password: pass },
        asResponse: true,
      });
      if (res.status === 200) {
        const body = await res.json();
        console.log(`Created new account: ${name} (${email})`);
        const headers = new Headers({
          cookie: res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; "),
        });
        return { id: body.user.id, name, email, password: pass, headers };
      }
    } catch {
      // already exists
    }

    const signInRes = await auth.api.signInEmail({
      body: { email, password: pass },
      asResponse: true,
    });
    if (signInRes.status !== 200) {
      throw new Error(`Failed to sign in account ${email}`);
    }
    const body = await signInRes.json();
    console.log(`Signed in existing account: ${name} (${email})`);
    const headers = new Headers({
      cookie: signInRes.headers.getSetCookie().map((v) => v.split(";")[0]).join("; "),
    });
    return { id: body.user.id, name, email, password: pass, headers };
  }

  // 1. Create Dedicated Accounts
  console.log("\n1. Setting up accounts...");
  const admin = await getOrCreateAccount(
    "Platform Administrator",
    "admin@sportozen.local",
    "SummitAdmin@2026!"
  );
  const owner = await getOrCreateAccount(
    "Vikram Malhotra",
    "owner.summit@sportozen.local",
    "SummitOwner@2026!"
  );
  const coachArjun = await getOrCreateAccount(
    "Arjun Mehta",
    "coach.arjun@sportozen.local",
    "CoachArjun@2026!"
  );
  const coachRahul = await getOrCreateAccount(
    "Rahul Sharma",
    "coach.rahul@sportozen.local",
    "CoachRahul@2026!"
  );
  const coachKaran = await getOrCreateAccount(
    "Karan Verma",
    "coach.karan@sportozen.local",
    "CoachKaran@2026!"
  );
  const parentSunita = await getOrCreateAccount(
    "Sunita Sharma",
    "parent.sunita@sportozen.local",
    "ParentSunita@2026!"
  );

  // Register Platform Admin in platform_administrators
  database()
    .prepare("INSERT OR IGNORE INTO platform_administrators(userId) VALUES(?)")
    .run(admin.id);
  console.log("Platform Administrator registered in platform_administrators table.");

  // Check if Summit Football Academy already exists
  const existingAcademy = database()
    .prepare("SELECT id, config FROM academy_workspaces WHERE json_extract(config, '$.name') = 'Summit Football Academy'")
    .get() as { id: string; config: string } | undefined;

  let academyId: string;

  if (existingAcademy) {
    academyId = existingAcademy.id;
    console.log(`Found existing Summit Football Academy (${academyId}), clearing prior test records for clean seed...`);
    atomic(() => {
      const db = database();
      db.prepare("DELETE FROM workspace_records WHERE academyId=?").run(academyId);
      db.prepare("DELETE FROM guardian_relationships WHERE academyId=?").run(academyId);
      db.prepare("DELETE FROM academy_finance_records WHERE academyId=?").run(academyId);
      db.prepare("DELETE FROM batch_announcements WHERE academyId=?").run(academyId);
    });
  } else {
    console.log("\n2. Creating Summit Football Academy workspace...");
    const created = await createAcademy(owner.headers, {
      name: "Summit Football Academy",
      location: "Sector 17, Chandigarh, India",
      about: "A professionally managed football academy providing structured training for junior and senior players.",
      contactEmail: "contact@summitacademy.in",
      phone: "+91 98140 12345",
      website: "https://summitfootball.example.com",
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      language: "English",
      dateLocale: "en-IN",
      weekStartsOn: 1,
      dateFormat: "DD_MMM_YYYY",
      timeFormat: "12_HOUR",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      demo: false,
      ageGroups: ["U10", "U12", "U14", "Senior"],
      modules: ["development", "reports", "communication", "fees"],
      reviewFrequency: "Coach review after comparable sessions",
    });
    academyId = created.id;
    console.log(`Created Summit Football Academy (${academyId})`);
  }

  // 3. Ensure Academy Lifecycle is ACTIVE with full audit history
  console.log("\n3. Setting up Academy Lifecycle approval history...");
  const at = new Date().toISOString();
  atomic(() => {
    const db = database();
    const row = db.prepare("SELECT state FROM academy_lifecycle WHERE academyId=?").get(academyId) as { state: string } | undefined;
    if (row && row.state !== "ACTIVE") {
      const reason = "Application reviewed and approved for comprehensive operations by Platform Administrator.";
      db.prepare(
        "UPDATE academy_lifecycle SET state='ACTIVE', version=version+1, decidedAt=?, decidedBy=?, reviewerId=?, reason=?, updatedAt=? WHERE academyId=?"
      ).run(at, "Platform Administrator", admin.id, reason, at, academyId);
      db.prepare(
        "INSERT INTO academy_lifecycle_history(academyId,fromState,toState,action,actorId,actorKind,reason,at) VALUES(?,?,?,?,?,'PLATFORM',?,?)"
      ).run(academyId, row.state, "ACTIVE", "APPROVED", admin.id, reason, at);
      console.log("Academy approved by Platform Admin with audit history.");
    }
  });

  // 4. Ensure Memberships for Coaches and Parent
  console.log("\n4. Ensuring Academy Memberships...");
  atomic(() => {
    const db = database();
    const addMember = (userId: string, role: string) => {
      db.prepare(
        "INSERT OR REPLACE INTO academy_memberships(id,academyId,userId,role,active,sportIds) VALUES(coalesce((SELECT id FROM academy_memberships WHERE academyId=? AND userId=?), ?), ?, ?, ?, 1, '[\"football\"]')"
      ).run(academyId, userId, randomUUID(), academyId, userId, role);
    };
    addMember(owner.id, "OWNER");
    addMember(coachArjun.id, "COACH");
    addMember(coachRahul.id, "COACH");
    addMember(coachKaran.id, "COACH");
    addMember(parentSunita.id, "PARENT");
  });
  console.log("Memberships verified: Owner, 3 Coaches, Parent.");

  // Get Contexts
  const ownerCtx = await context(owner.headers, academyId);
  const coachCtx = await context(coachArjun.headers, academyId);

  // Helper for training actions
  function train<T>(ctx: WorkspaceAccess, action: string, data: unknown, id?: string, expectedVersion = 0): T {
    return trainingAction(ctx, {
      requestId: randomUUID(),
      action,
      data,
      id,
      expectedVersion,
    }) as T;
  }

  // Helper for finance actions
  function finance<T>(ctx: WorkspaceAccess, action: string, data: unknown, id?: string, expectedVersion = 0): T {
    return financeAction(ctx, {
      requestId: randomUUID(),
      action,
      data,
      id,
      expectedVersion,
    }) as T;
  }

  // 5. Create Infrastructure (Branch, Venues)
  console.log("\n5. Setting up Branch and Venues...");
  const branch = saveRecord(ownerCtx, "branch", {
    name: "Summit Main Campus",
    timezone: "Asia/Kolkata",
    location: "Sector 17 Stadium Complex, Chandigarh",
  }) as { id: string };

  const venue1 = train<FootballVenue>(ownerCtx, "venue", {
    name: "Sector 17 Stadium (Main Pitch)",
    branchId: branch.id,
    location: "Sector 17 Stadium, Chandigarh",
    exclusive: true,
  });

  const venue2 = train<FootballVenue>(ownerCtx, "venue", {
    name: "Sector 43 Astro Turf Ground",
    branchId: branch.id,
    location: "Sector 43 Sports Complex, Chandigarh",
    exclusive: true,
  });
  console.log(`Created branch (${branch.id}) and venues: ${venue1.name}, ${venue2.name}`);

  // 6. Create Drills Library with exact vocabulary
  console.log("\n6. Setting up Drills Library...");
  const drillReceiveTurn = saveRecord(ownerCtx, "drill", {
    sportId: "football",
    name: "Receive & Turn under Pressure",
    focusArea: "Receiving",
    category: "ball-control-dribbling",
    purpose: "Open body shape, scanning shoulder, and first touch into space",
    cue: "Look before receiving, take touch across defender",
  }) as WorkspaceDrill;

  const drillPassMove = saveRecord(ownerCtx, "drill", {
    sportId: "football",
    name: "Pass & Move 3v1 Rondo",
    focusArea: "Passing",
    category: "passing-combination-play",
    purpose: "Weight of pass, body angle, and creating immediate support angles",
    cue: "Firm pass along carpet, move to open passing line",
  }) as WorkspaceDrill;

  const drill1v1Finishing = saveRecord(ownerCtx, "drill", {
    sportId: "football",
    name: "1v1 Attacking & Composed Finishing",
    focusArea: "Finishing",
    category: "shooting-crossing-finishing",
    purpose: "Direct 1v1 dribble, shifting defender off balance, composed low finish",
    cue: "Attack front foot of defender, aim for bottom corners",
  }) as WorkspaceDrill;

  const drillDefensiveShape = saveRecord(ownerCtx, "drill", {
    sportId: "football",
    name: "Defensive Shape & Compact Unit",
    focusArea: "Defending",
    category: "defending-pressing",
    purpose: "Zonal compactness, shifting as a four, press triggers",
    cue: "Stay compact, move as the ball travels",
  }) as WorkspaceDrill;

  const drillDribbling = saveRecord(ownerCtx, "drill", {
    sportId: "football",
    name: "Close-Control Direction Shift",
    focusArea: "Dribbling",
    category: "ball-control-dribbling",
    purpose: "Rapid change of pace and protecting ball with low center of gravity",
    cue: "Fast feet, keep ball within playing distance",
  }) as WorkspaceDrill;
  console.log("Drills created successfully!");

  // 7. Create 14 Players
  console.log("\n7. Setting up 14 Players across Batches...");
  const playerDefs = [
    { name: "Aarav Sharma", ageCategory: "U12", pos: "Midfielder", dob: "2014-04-12", coachId: coachArjun.id, squad: "U12 Advanced" },
    { name: "Vihaan Mehta", ageCategory: "U12", pos: "Forward", dob: "2014-07-22", coachId: coachArjun.id, squad: "U12 Advanced" },
    { name: "Reyansh Kapoor", ageCategory: "U12", pos: "Defender", dob: "2014-11-05", coachId: coachArjun.id, squad: "U12 Advanced" },
    { name: "Advik Singh", ageCategory: "U12", pos: "Goalkeeper", dob: "2014-02-18", coachId: coachArjun.id, squad: "U12 Advanced" },
    { name: "Arnav Verma", ageCategory: "U10", pos: "Forward", dob: "2016-03-14", coachId: coachRahul.id, squad: "U10 Development" },
    { name: "Kabir Malhotra", ageCategory: "U10", pos: "Midfielder", dob: "2016-08-09", coachId: coachRahul.id, squad: "U10 Development" },
    { name: "Ishaan Gupta", ageCategory: "U10", pos: "Defender", dob: "2016-01-30", coachId: coachRahul.id, squad: "U10 Development" },
    { name: "Ayaan Khanna", ageCategory: "U10", pos: "Winger", dob: "2017-05-12", coachId: coachRahul.id, squad: "U10 Development" },
    { name: "Rohan Patel", ageCategory: "U14", pos: "Midfielder", dob: "2012-09-17", coachId: coachArjun.id, squad: "U14 Competitive" },
    { name: "Dhruv Nair", ageCategory: "U14", pos: "Defender", dob: "2012-12-03", coachId: coachArjun.id, squad: "U14 Competitive" },
    { name: "Samar Joshi", ageCategory: "U14", pos: "Forward", dob: "2013-04-25", coachId: coachArjun.id, squad: "U14 Competitive" },
    { name: "Tanmay Bhatia", ageCategory: "U14", pos: "Goalkeeper", dob: "2012-06-11", coachId: coachArjun.id, squad: "U14 Competitive" },
    { name: "Armaan Gill", ageCategory: "Senior", pos: "Center Back", dob: "2009-08-19", coachId: coachKaran.id, squad: "Senior Training" },
    { name: "Yuvraj Chauhan", ageCategory: "Senior", pos: "Striker", dob: "2008-11-02", coachId: coachKaran.id, squad: "Senior Training" },
  ];

  const players: WorkspacePlayer[] = [];
  for (const def of playerDefs) {
    const p = saveRecord(ownerCtx, "player", {
      name: def.name,
      sportIds: ["football"],
      squad: def.squad,
      ageCategory: def.ageCategory,
      birthDate: def.dob,
      position: def.pos,
      coachId: def.coachId,
      status: "ACTIVE",
    }) as WorkspacePlayer;
    players.push(p);
  }

  const aarav = players.find((p) => p.name === "Aarav Sharma")!;

  // 8. Explicitly Link Guardian Sunita Sharma to Aarav Sharma
  console.log("\n8. Linking Guardian Sunita Sharma to child Aarav Sharma...");
  database()
    .prepare("INSERT OR REPLACE INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)")
    .run(academyId, parentSunita.id, aarav.id);
  console.log(`Linked parent ${parentSunita.email} to child ${aarav.name} (${aarav.id})`);

  // 9. Create Squads and Assign Players
  console.log("\n9. Setting up Squads/Batches...");
  const u12Players = players.filter((p) => p.squad === "U12 Advanced");
  const u10Players = players.filter((p) => p.squad === "U10 Development");
  const u14Players = players.filter((p) => p.squad === "U14 Competitive");
  const seniorPlayers = players.filter((p) => p.squad === "Senior Training");

  const squadU12 = train<FootballSquad>(ownerCtx, "squad", {
    name: "U12 Advanced",
    branchId: branch.id,
    playerIds: u12Players.map((p) => p.id),
  });

  const squadU10 = train<FootballSquad>(ownerCtx, "squad", {
    name: "U10 Development",
    branchId: branch.id,
    playerIds: u10Players.map((p) => p.id),
  });

  const squadU14 = train<FootballSquad>(ownerCtx, "squad", {
    name: "U14 Competitive",
    branchId: branch.id,
    playerIds: u14Players.map((p) => p.id),
  });

  const squadSenior = train<FootballSquad>(ownerCtx, "squad", {
    name: "Senior Training",
    branchId: branch.id,
    playerIds: seniorPlayers.map((p) => p.id),
  });
  console.log("Squads created: U12 Advanced, U10 Development, U14 Competitive, Senior Training.");

  // 10. Create Development Plan for Aarav Sharma
  console.log("\n10. Setting up Player Development Plan for Aarav Sharma...");
  const aaravPlan = saveRecord(coachCtx, "plan", {
    playerId: aarav.id,
    coachId: coachArjun.id,
    sportId: "football",
    focus: "Passing",
    reason: "Aarav has high technical promise; early scanning will elevate his playmaking",
    drillIds: [drillReceiveTurn.id, drillPassMove.id],
    observe: "Body shape when opening hips, touch away from presser, speed of pass delivery",
    homePractice: "Wall passing with alternate feet, 100 reps daily concentrating on ankle lock",
    reviewDate: "2026-11-20",
    nextStep: "Progress to 1-touch combination play in tight central pockets",
    status: "ACTIVE",
    privateNote: "Coach observation: exceptional coachability and high technical upside.",
  }) as WorkspacePlan;

  // 11. Create Training Sessions
  console.log("\n11. Creating Training Sessions...");
  
  // Session 1: Completed session
  const session1Draft = train<FootballSession>(coachCtx, "session", {
    branchId: branch.id,
    squadId: squadU12.id,
    venueId: venue1.id,
    location: venue1.location,
    coachIds: [coachArjun.id],
    timezone: "Asia/Kolkata",
    startLocal: "2026-11-03T17:30",
    endLocal: "2026-11-03T19:00",
    title: "U12 Passing and Ball Control",
    theme: "Passing and Possession",
    agenda: [
      { drillId: drillReceiveTurn.id, duration: 25 },
      { drillId: drillPassMove.id, duration: 35 },
      { drillId: drill1v1Finishing.id, duration: 30 },
    ],
    sharedObjective: {
      goal: "Maintain passing tempo and execute combination play with 2 touches max",
      cue: "Firm passes, quick movement into open lanes",
      observe: "Supporting angle distance and vocal communication",
    },
  });

  // Schedule -> Add Objective -> In Progress
  const session1Scheduled = train<FootballSession>(coachCtx, "status", { status: "SCHEDULED" }, session1Draft.id, session1Draft.version);
  
  const session1WithObj = train<FootballSession>(coachCtx, "objective", {
    playerId: aarav.id,
    planId: aaravPlan.id,
    drillId: drillPassMove.id,
    goal: "Maintain 80%+ passing completion in 3v1 rondo",
    cue: "Scan over left shoulder before touch",
    observe: "Body shape and weight of pass into stride",
  }, session1Scheduled.id, session1Scheduled.version);

  const session1InProgress = train<FootballSession>(coachCtx, "status", { status: "IN_PROGRESS" }, session1WithObj.id, session1WithObj.version);

  // Mark Attendance
  train(coachCtx, "attendance", {
    entries: [
      { playerId: u12Players[0].id, status: "PRESENT", expectedVersion: 1 },
      { playerId: u12Players[1].id, status: "PRESENT", expectedVersion: 1 },
      { playerId: u12Players[2].id, status: "PRESENT", expectedVersion: 1 },
      { playerId: u12Players[3].id, status: "EXCUSED", expectedVersion: 1 },
    ],
    correctionReason: "Verified coach check-in at session start.",
  }, session1Draft.id);

  // Record Evidence for Aarav Sharma
  const ev = train<{ id: string }>(coachCtx, "evidence", {
    sessionId: session1Draft.id,
    playerId: aarav.id,
    planId: aaravPlan.id,
    drillId: drillPassMove.id,
    conditions: "3v1 Rondo under dynamic pressing in 10x10 grid",
    observation: "Aarav completed 8 of 10 line-breaking passes with exceptional weight. Body shape has noticeably improved.",
    staffNote: "Ready for transition to 4v2 exercises.",
    type: "COACH_OBSERVATION",
    visibility: "PARENT_ELIGIBLE",
    measurement: "ATTEMPTS",
    attempts: 10,
    successes: 8,
    method: "Coach live count during 10-minute sequence",
  });

  // Review Evidence
  train(coachCtx, "review", {
    status: "REVIEWED",
    verified: true,
  }, ev.id, (ev as { version?: number }).version ?? 1);

  // Complete Session
  train(coachCtx, "status", { status: "COMPLETED" }, session1Draft.id, session1InProgress.version);

  // Record Session Wrap-Up
  train(coachCtx, "wrapup", {
    drills: [
      { drillId: drillReceiveTurn.id, outcome: "COMPLETED", actualMinutes: 25, note: "Good body orientation" },
      { drillId: drillPassMove.id, outcome: "COMPLETED", actualMinutes: 35, note: "High passing accuracy" },
      { drillId: drill1v1Finishing.id, outcome: "COMPLETED", actualMinutes: 30, note: "Good composure in front of goal" },
    ],
    observations: "High intensity session with rapid transition play. Squad connected 78% of passes.",
    achievements: "Aarav and Vihaan connected seamlessly across the central zone.",
    improvements: "Need to communicate earlier before receiving the pass.",
  }, session1Draft.id);
  console.log("Created completed session with attendance, evidence and wrap-up.");

  // Session 2: Upcoming Scheduled Session
  const session2Draft = train<FootballSession>(coachCtx, "session", {
    branchId: branch.id,
    squadId: squadU12.id,
    venueId: venue1.id,
    location: venue1.location,
    coachIds: [coachArjun.id],
    timezone: "Asia/Kolkata",
    startLocal: "2026-11-05T17:30",
    endLocal: "2026-11-05T19:00",
    title: "U12 Tactical Awareness & Position Play",
    theme: "Tactical Positioning & Pressing",
    agenda: [
      { drillId: drillDefensiveShape.id, duration: 35 },
      { drillId: drillPassMove.id, duration: 25 },
    ],
    sharedObjective: {
      goal: "Shift as a defensive four when opponent switches play",
      cue: "Stay compact within 25 yards",
      observe: "Communication between center-back and goalkeeper",
    },
  });
  train(coachCtx, "status", { status: "SCHEDULED" }, session2Draft.id, session2Draft.version);
  console.log(`Created upcoming scheduled session (${session2Draft.id})`);

  // Session 3: Cancelled Session
  const session3Draft = train<FootballSession>(coachCtx, "session", {
    branchId: branch.id,
    squadId: squadU12.id,
    venueId: venue2.id,
    location: venue2.location,
    coachIds: [coachArjun.id],
    timezone: "Asia/Kolkata",
    startLocal: "2026-11-07T16:30",
    endLocal: "2026-11-07T18:00",
    title: "U12 Speed and Agility",
    theme: "Speed & Quickness",
    agenda: [
      { drillId: drillDribbling.id, duration: 30 },
    ],
  });
  const session3Scheduled = train<FootballSession>(coachCtx, "status", { status: "SCHEDULED" }, session3Draft.id, session3Draft.version);
  train(coachCtx, "status", {
    status: "CANCELLED",
    reason: "Turf maintenance and inclement weather forecast. Parents notified.",
  }, session3Draft.id, session3Scheduled.version);
  console.log(`Created cancelled session (${session3Draft.id})`);

  // 12. Create and Approve Monthly Report for Aarav Sharma
  console.log("\n12. Creating Monthly Report for Aarav Sharma...");
  const report = saveRecord(coachCtx, "report", {
    playerId: aarav.id,
    sportId: "football",
    planId: aaravPlan.id,
    period: "October 2026",
    observation: "Aarav has shown remarkable tactical discipline and ball composure throughout October. Nominated as squad captain for his vocal encouragement and leadership on the pitch.",
    evidenceType: "COACH_OBSERVATION",
    nextStep: "Progress to 1-touch combination play in tight central pockets under aggressive pressing.",
    closingNote: "Outstanding consistency and positive work ethic. 92% attendance recorded across all October training sessions.",
  }) as WorkspaceReport;

  // Approve report
  approveReport(coachCtx, report.id, true);
  console.log(`Created and approved monthly development report (${report.id})`);

  // 13. Create Fee Plans and Invoices
  console.log("\n13. Setting up Finance Plans, Invoices, and Payment Verification...");
  const planU12 = finance<{ id: string }>(ownerCtx, "plan", {
    name: "U12 Monthly Development Plan",
    sportId: "football",
    billingFrequency: "MONTHLY",
    amountMinor: 350000, // ₹3,500.00
    currency: "INR",
    applicableStartDate: "2026-01-01",
    description: "Full football coaching, tactical sessions, weekend friendly matches and video analysis.",
    active: true,
  });

  const planU10 = finance<{ id: string }>(ownerCtx, "plan", {
    name: "U10 Foundation Plan",
    sportId: "football",
    billingFrequency: "MONTHLY",
    amountMinor: 300000, // ₹3,000.00
    currency: "INR",
    applicableStartDate: "2026-01-01",
    description: "Grassroots football fundamentals, coordination, agility and fun matches.",
    active: true,
  });

  const planU14 = finance<{ id: string }>(ownerCtx, "plan", {
    name: "U14 Competitive Plan",
    sportId: "football",
    billingFrequency: "MONTHLY",
    amountMinor: 450000, // ₹4,500.00
    currency: "INR",
    applicableStartDate: "2026-01-01",
    description: "High-performance league coaching, tactical analysis, strength & conditioning.",
    active: true,
  });

  // Assign U12 plan to U12 squad
  finance(ownerCtx, "batchAssignment", {
    planId: planU12.id,
    squadId: squadU12.id,
    effectiveFrom: "2026-01-01",
    active: true,
  });

  // Issue October Invoice for Aarav Sharma
  const invoiceOct = finance<{ id: string }>(ownerCtx, "invoice", {
    playerId: aarav.id,
    planId: planU12.id,
    label: "October 2026 Training Fee - U12 Advanced",
    chargeMinor: 350000,
    currency: "INR",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    dueDate: "2026-10-10",
  });

  // Record Payment Reference (e.g. parent submitted UPI ref, owner logs it)
  const paymentRef = finance<{ id: string; version?: number }>(ownerCtx, "reference", {
    invoiceId: invoiceOct.id,
    amountMinor: 350000,
    currency: "INR",
    reference: "UPI-HDFC-982341",
    method: "UPI",
    paidOn: "2026-10-15",
  });

  // Verify Payment by Owner -> Generates Official Receipt!
  finance(ownerCtx, "verify", {
    reviewed: true,
    note: "Verified in academy bank statement against UPI reference UPI-HDFC-982341.",
  }, paymentRef.id, paymentRef.version ?? 1);

  // Issue November Invoice for Aarav Sharma (Issued, currently outstanding)
  finance(ownerCtx, "invoice", {
    playerId: aarav.id,
    planId: planU12.id,
    label: "November 2026 Training Fee - U12 Advanced",
    chargeMinor: 350000,
    currency: "INR",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    dueDate: "2026-11-15",
  });
  console.log("Finance configured: 3 Plans, Oct Invoice Verified & Paid (₹3,500), Nov Invoice Issued (₹3,500).");

  // 14. Create Batch Announcements
  console.log("\n14. Publishing Batch Announcements...");
  atomic(() => {
    const db = database();
    const id1 = randomUUID();
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const ann1 = {
      id: id1,
      academyId,
      version: 1,
      authorId: owner.id,
      kind: "SPECIAL_PRACTICE" as const,
      urgency: "NORMAL" as const,
      batchIds: [squadU12.id, squadU10.id, squadU14.id, squadSenior.id],
      body: "Summit Football Academy will host the Chandigarh Youth Cup friendly exhibition matches on Sunday Nov 15th at Sector 17 Stadium. Schedule details will be shared by head coaches.",
      expiresAt: expiresIso,
      status: "APPROVED" as const,
      createdAt: nowIso,
      updatedAt: nowIso,
      approval: {
        reviewerId: owner.id,
        approvedAt: nowIso,
        fingerprint: "summit-ann-01",
        renderedBody: "Summit Football Academy will host the Chandigarh Youth Cup friendly exhibition matches on Sunday Nov 15th at Sector 17 Stadium.",
        templateName: "operational_notice",
        recipients: [],
      },
    };

    const id2 = randomUUID();
    const ann2 = {
      id: id2,
      academyId,
      version: 1,
      authorId: coachArjun.id,
      kind: "TIME_CHANGED" as const,
      urgency: "NORMAL" as const,
      batchIds: [squadU12.id],
      body: "Winter training schedule effective Nov 10th: U12 Advanced weekday evening sessions will start promptly at 5:00 PM to maximize daylight.",
      expiresAt: expiresIso,
      status: "APPROVED" as const,
      createdAt: nowIso,
      updatedAt: nowIso,
      approval: {
        reviewerId: owner.id,
        approvedAt: nowIso,
        fingerprint: "summit-ann-02",
        renderedBody: "Winter training schedule effective Nov 10th: U12 Advanced weekday evening sessions will start promptly at 5:00 PM.",
        templateName: "time_change_notice",
        recipients: [],
      },
    };

    for (const ann of [ann1, ann2]) {
      db.prepare("INSERT INTO batch_announcement_history VALUES(?,?,?,?)").run(
        ann.academyId,
        ann.id,
        ann.version,
        JSON.stringify(ann),
      );
      db.prepare(
        "INSERT INTO batch_announcements VALUES(?,?,?) ON CONFLICT(academyId,id) DO UPDATE SET body=excluded.body",
      ).run(ann.academyId, ann.id, JSON.stringify(ann));
    }
  });
  console.log("Announcements recorded.");

  console.log("\n=== Seeding Completed Successfully! ===");
  console.log(`Academy ID: ${academyId}`);
  console.log("Dedicated Demo Accounts Handover:");
  console.log(`1. Platform Admin : ${admin.email} / ${admin.password}`);
  console.log(`2. Academy Owner  : ${owner.email} / ${owner.password}`);
  console.log(`3. Head Coach     : ${coachArjun.email} / ${coachArjun.password}`);
  console.log(`4. U12 Coach      : ${coachRahul.email} / ${coachRahul.password}`);
  console.log(`5. Fitness Coach  : ${coachKaran.email} / ${coachKaran.password}`);
  console.log(`6. Parent         : ${parentSunita.email} / ${parentSunita.password}`);
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
