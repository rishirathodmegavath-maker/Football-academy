import type { UniversalDrill } from "@/domain/drill-library";
import {
  Ball,
  C,
  Circle,
  Goal,
  P,
  Pass,
  Run,
  Text,
  Zone,
  grid,
  layout,
  pitchThirds,
  slalom,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "fitness-speed-goalkeeping" as const;

const effortSafety = [
  "Players warm up before any fast running; the coach decides the number of efforts and the rest from the players' age, condition and technique, and stops efforts when quality drops.",
  SAFE.water,
  SAFE.surface,
  SAFE.stop,
];

export const fitnessSpeedGoalkeeping: UniversalDrill[] = [
  drill({
    number: 46,
    categoryId: cat,
    name: "Sprinting Circuit with Ball",
    originalObjective:
      "Anaerobic conditioning and technical execution.",
    focusArea: "Dribbling",
    purpose: "Combines fast running with good ball control.",
    cue: "Run fast, stay in control and finish well.",
    summary:
      "A circuit of short, fast efforts with the ball, each finishing with a pass, with full rest between efforts.",
    interpretation:
      "Sportozen's content describes short, fast efforts with the ball and full rest. It makes no physiological claims, and the number of efforts, distances and rest are set by the coach.",
    content: {
      description:
        "Players take turns to complete a circuit of cones with the ball, running fast between the cones and finishing with an accurate pass to a target. Each effort is short and fast, followed by a full rest. The aim is to keep ball control and passing quality when running at pace.",
      skills: ["Dribbling at speed", "Technique under fatigue", "Passing accuracy", "Pace"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 4, max: 16 },
      equipment: ["Cones for the circuit", "One ball per player", "A target (goal or cones)", "A timer"],
      setup: {
        layout:
          "A circuit of cones forming a loop with a finishing zone and a target. Players queue at the start; one player works at a time.",
        dimensions: DIM.lane,
      },
      steps: [
        "The first player dribbles round the circuit as fast as they can control the ball.",
        "At the finishing zone the player passes the ball into the target.",
        "Walk or jog back for a full rest while the next player goes.",
        "Repeat for the number of efforts the coach has chosen for the group.",
        "Finish with a cool-down.",
      ],
      coachingPoints: [
        "Keep the ball close even at top speed.",
        "Accelerate out of the turns.",
        "Finish with a clean, accurate pass.",
        "Recover fully before the next effort.",
      ],
      commonMistakes: [
        "Losing control by pushing the ball too far.",
        "Slowing down at the finish.",
        "Not resting enough between efforts.",
      ],
      progressions: {
        easier: [
          "Shorter circuit and slower pace.",
          "Longer rest.",
        ],
        harder: [
          "Add a turn or a change of direction.",
          "Shorten the rest only if technique stays good.",
        ],
      },
      safety: [
        ...effortSafety,
        "Only one player runs at a time on the circuit and the run-off area is kept clear.",
      ],
      phase: "CONDITIONING",
      intensity: "HIGH",
      tags: ["conditioning", "sprint", "dribbling", "circuit", "speed"],
      references: [
        REF.uefaGrassroots,
        limitation("No source for this exact circuit was located. No distances, effort counts or rest durations are specified."),
      ],
      diagram: slalom({
        cones: 4,
        caption:
          "A circuit: sprint-dribble through the cones, finish with a pass to the target, then walk back to rest.",
        extra: [Goal(86, 8, 10), Pass(88, 26, 91, 11, 6), Run(90, 40, 12, 46, 7)],
      }),
    },
  }),
  drill({
    number: 47,
    categoryId: cat,
    name: "Center Circle Transition Sprints",
    originalObjective: "High-intensity recovery runs.",
    focusArea: "Recovery movement",
    purpose: "Practises fast recovery runs after possession changes.",
    cue: "React to the call and recover quickly.",
    summary:
      "Players sprint out from the centre circle on a call and recover back, practising fast runs after the ball changes hands.",
    interpretation:
      "'Recovery runs' are defensive recovery runs back to a position after possession is lost, not physical rest.",
    content: {
      description:
        "Players stand on the centre circle. On the coach's call they sprint to a marker and then run back into position, simulating a recovery run after losing the ball. Calls vary so players must react. Each effort is followed by a full rest.",
      skills: ["Recovery runs", "Reaction speed", "Acceleration", "Transition"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 4, max: 20 },
      equipment: ["Cones for markers", "A whistle", "Optional balls"],
      setup: {
        layout:
          "Players spaced around the centre circle, each with a lane to a marker outside the circle. Lanes do not cross.",
        dimensions: DIM.lane,
      },
      steps: [
        "Players stand ready on the circle in their own lanes.",
        "On the first call they sprint out to the marker in their lane.",
        "On the second call they turn and run back in to the circle, as in a recovery run.",
        "Walk or jog to rest and reset before the next call.",
        "Vary the calls, including some where players stay in place to test reactions.",
      ],
      coachingPoints: [
        "Explosive first steps on the call.",
        "Stay in your own lane and keep your head up.",
        "Turn quickly and push off hard.",
        "Recover fully before the next effort.",
      ],
      commonMistakes: [
        "Anticipating the call.",
        "Wandering out of the lane.",
        "Not resting enough.",
      ],
      progressions: {
        easier: [
          "Slower calls and shorter lanes.",
          "More rest.",
        ],
        harder: [
          "Add a ball to dribble back.",
          "Combine with a pass after the recovery.",
        ],
      },
      safety: [
        ...effortSafety,
        "Lanes must not cross and all players run in the same direction on the same call.",
      ],
      phase: "CONDITIONING",
      intensity: "HIGH",
      tags: ["conditioning", "recovery runs", "sprint", "transition", "centre circle"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact practice was located. No distances or effort counts are specified."),
      ],
      diagram: layout(
        "pitch-thirds",
        "PITCH",
        [
          Circle(50, 32, 12),
          Goal(0, 26, 2, 12),
          Goal(98, 26, 2, 12),
          P(50, 20, "A"),
          P(62, 32, "A"),
          P(50, 44, "A"),
          P(38, 32, "A"),
          C(50, 6),
          C(82, 32),
          C(50, 58),
          C(18, 32),
          Run(50, 19, 50, 8, 1),
          Run(63, 32, 80, 32, 2),
          Run(50, 45, 50, 56, 3),
          Run(37, 32, 20, 32, 4),
          Text(26, 10, "First call: sprint out. Second call: run back."),
        ],
        "Players on the centre circle sprint out along separate lanes on a call and run back in on the next call.",
      ),
    },
  }),
  drill({
    number: 48,
    categoryId: cat,
    name: "Goalkeeping Basic Handling & Angles",
    originalObjective: "Shot-blocking and footwork positioning.",
    focusArea: "Goalkeeping",
    purpose: "Introduces goalkeepers to catching shots and good positioning.",
    cue: "Get set, move your feet and get behind the ball.",
    summary:
      "Goalkeepers practise the ready position, catching shots and moving their feet to narrow the angle.",
    content: {
      description:
        "A goalkeeper works with a server and shooters. They practise a balanced ready position, getting their body behind the ball to catch it, and small footwork steps to adjust their position so that the shooter has less goal to aim at. The emphasis is on handling and position before diving or power.",
      skills: ["Handling", "Footwork", "Positioning", "Narrowing the angle"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 14,
      players: { min: 3, max: 10 },
      equipment: [
        "A goal (anchored)",
        "Balls suited to the age group",
        "Goalkeeper gloves (optional)",
        "Cones to mark servers' positions",
      ],
      setup: {
        layout:
          "A goal with the goalkeeper on the line. Servers at marked positions in front of and to the sides of the goal.",
        dimensions: DIM.half,
      },
      steps: [
        "The goalkeeper adopts a balanced ready position facing the ball.",
        "A server plays a gentle shot straight at the goalkeeper to catch with the body behind the ball.",
        "The server then plays to either side so the goalkeeper takes small steps to reach the ball.",
        "Next, the server moves out wider and the goalkeeper adjusts position by stepping towards the ball to narrow the angle.",
        "The goalkeeper returns to the ready position between every shot.",
        "Rotate goalkeepers and servers regularly.",
      ],
      coachingPoints: [
        "Stay light on the toes with the weight forward.",
        "Hands behind and under the ball, with the body behind the hands.",
        "Small, quick steps rather than big ones.",
        "Return to a set position after every save.",
      ],
      commonMistakes: [
        "Standing flat-footed.",
        "Reaching with the hands but leaving the body behind.",
        "Not returning to the ready position.",
      ],
      progressions: {
        easier: [
          "Underarm throws or rolled balls.",
          "Shots at a gentle pace.",
        ],
        harder: [
          "Faster shots or two quick shots.",
          "Add a moving server who changes angle.",
        ],
      },
      safety: [
        SAFE.goal,
        "Begin with gentle service and increase pace only as technique and confidence grow; avoid hard diving on firm surfaces.",
        "Check that the goalmouth and surface are free of hazards before starting.",
        "Servers wait until the goalkeeper is ready.",
      ],
      phase: "MAIN",
      intensity: "LOW",
      tags: ["goalkeeping", "handling", "angles", "footwork", "positioning"],
      references: [
        REF.uefaGrassroots,
        limitation("No published goalkeeping source was located; this content is general and a qualified goalkeeping coach should review it."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          P(50, 6, "GK"),
          P(50, 38, "A", "S1"),
          P(26, 34, "A", "S2"),
          P(74, 34, "A", "S3"),
          Ball(50, 36),
          Pass(50, 36, 50, 9, 1),
          Pass(26, 32, 44, 8, 2),
          Pass(74, 32, 56, 8, 3),
          Run(50, 9, 46, 14, 4),
          Text(50, 60, "Servers S1 to S3; the goalkeeper adjusts position for each angle"),
        ],
        "A goalkeeper (GK) catches shots from three servers and steps to narrow the angle.",
      ),
    },
  }),
  drill({
    number: 49,
    categoryId: cat,
    name: "Heading Control & Clearance",
    originalObjective: "Aerial timing and directional heading.",
    focusArea: "Defending",
    purpose: "Practises clearing the ball safely and keeping control under pressure.",
    cue: "Clear the ball away from danger, calmly.",
    summary:
      "DRAFT: not published. The non-heading part covers controlling and clearing with the foot and chest. The heading component is not authored.",
    status: "DRAFT",
    interpretation:
      "Stored as DRAFT. The drill is split into a non-heading control and clearance part (written below) and a heading part that is not authored and cannot be enabled until the relevant country's guidance has been verified against primary sources. India is the initial jurisdiction and no Indian guidance has been verified.",
    headingComponent: {
      state: "NOT_AUTHORED_PENDING_VERIFICATION",
      note: "No heading instruction, age limit or repetition limit has been written. It may only be authored and enabled after primary-source verification for the academy's country.",
    },
    content: {
      description:
        "A defender receives a ball played towards them and chooses between controlling it and clearing it. The clearance part trains clearing the ball with the foot or controlling it with the chest and thigh, aiming to safe wide areas. This draft contains the control and clearance part only.",
      skills: ["Clearances", "Control", "Decision-making", "Positioning"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 3, max: 12 },
      equipment: ["Balls", "Cones to mark clearance zones", "Bibs"],
      setup: {
        layout:
          "A defender stands in front of a goal area with a server in front. Two wide target zones are marked to the sides.",
        dimensions: DIM.half,
      },
      steps: [
        "The server plays a low or bouncing ball towards the defender.",
        "The defender decides: clear it or control it and play out.",
        "To clear, strike through the ball with the foot towards a wide target zone, away from the goal.",
        "To control, cushion the ball with the chest or thigh and play it to safety.",
        "Rotate defenders and servers.",
      ],
      coachingPoints: [
        "Decide early and tell your team what you will do.",
        "Clear wide and high enough to be safe, away from the goal.",
        "Stay balanced and watch the ball onto your foot.",
        "Recover your position after the clearance.",
      ],
      commonMistakes: [
        "Hesitating and letting the ball bounce.",
        "Clearing into the middle of the pitch.",
        "Not communicating.",
      ],
      progressions: {
        easier: [
          "Gentle, low service.",
          "Defender has more time.",
        ],
        harder: [
          "Add a challenging attacker.",
          "Vary the service.",
        ],
      },
      safety: [
        "This draft contains no heading instruction. Heading is not to be added until the academy country's guidance is verified from primary sources.",
        "Keep service gentle and controlled for the group.",
        SAFE.space,
      ],
      phase: "MAIN",
      intensity: "LOW",
      tags: ["defending", "clearance", "control", "draft"],
      references: [
        limitation(
          "Heading guidance from football associations was reported in news sources (England, Scotland, Northern Ireland, and a US Youth Soccer rule) but the primary pages could not be opened to verify it, and no Indian guidance was found. No heading content is authored.",
        ),
      ],
      diagram: grid({
        players: [
          Zone(8, 8, 18, 40, "Wide zone"),
          Zone(74, 8, 18, 40, "Wide zone"),
          Goal(40, 4, 20),
          P(50, 22, "A", "D"),
          P(50, 54, "A", "S"),
          Ball(52, 52),
          Pass(52, 52, 50, 26, 1),
          Pass(50, 24, 18, 16, 2),
        ],
        caption:
          "A server plays a low ball to the defender (D), who clears it to a wide zone or controls it. Non-heading draft.",
        area: { x: 4, y: 4, w: 92, h: 56 },
      }),
    },
  }),
  drill({
    number: 50,
    categoryId: cat,
    name: "Field Thirds Shape & Switching",
    originalObjective: "Full-team tactical shift and endurance.",
    focusArea: "Positioning",
    purpose: "Teaches the whole team to move together and switch play.",
    cue: "Move as a team and switch quickly.",
    summary:
      "A near full-team practice where the team's shape shifts through the pitch thirds as the ball moves, with quick switches of play.",
    interpretation:
      "A near full-team practice with continuous movement of the team's shape through the thirds of the pitch. 'Endurance' comes from continuous play; no physiological claims are made.",
    content: {
      description:
        "A full team (or nearly) plays against a smaller opposition on a full or large pitch divided into thirds. As the ball moves from one third to another, the whole team shifts together, keeping its shape. Players practise switching the ball from one side to the other to unbalance the opposition. The play is continuous, so players stay active throughout.",
      skills: ["Team shape", "Shifting", "Switching play", "Communication"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 16,
      players: { min: 10, max: 22, note: "A near full team is needed to show the shape" },
      equipment: ["Cones to mark the thirds", "Goals", "Balls", "Bibs"],
      setup: {
        layout:
          "A pitch marked into three thirds with cones. One team plays in its shape against a smaller opposition.",
        dimensions: DIM.half,
      },
      steps: [
        "The team lines up in its shape across the thirds.",
        "As the ball moves into a third, the whole team shifts to keep a compact shape around it.",
        "On the coach's signal the ball is switched quickly to the opposite side of the pitch.",
        "The team shifts again and keeps its distances.",
        "Rotate players and positions, then repeat with the opposition applying more pressure.",
      ],
      coachingPoints: [
        "Move together: keep the distances between the lines.",
        "Switch quickly and accurately.",
        "Communicate who shifts and who covers.",
        "Recover into shape after every switch.",
      ],
      commonMistakes: [
        "Players moving individually and breaking the shape.",
        "Slow switches that let the opposition recover.",
        "Not communicating.",
      ],
      progressions: {
        easier: [
          "Walk through the shifts without the opposition.",
          "Fewer players in the shape.",
        ],
        harder: [
          "Add a pressing opposition.",
          "Limit touches on the switch.",
        ],
      },
      safety: [
        "Check for enough players and a clear pitch before starting; adapt the pitch size and play to the players' fitness.",
        SAFE.water,
        SAFE.surface,
        SAFE.stop,
      ],
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["tactical", "team shape", "thirds", "switching", "full team"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact format was located."),
      ],
      diagram: pitchThirds({
        caption:
          "A team shape across the thirds: the ball is switched to the far side and the team shifts together.",
      }),
    },
  }),
];
