import type { UniversalDrill } from "@/domain/drill-library";
import {
  Ball,
  C,
  P,
  Pass,
  Run,
  Text,
  Zone,
  grid,
  hourglass,
  layout,
  triangle,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "passing-combination-play" as const;

export const passingCombinationPlay: UniversalDrill[] = [
  drill({
    number: 16,
    categoryId: cat,
    name: "Three-Player Passing Triangles",
    originalObjective: "Quick wall-passes and angle support.",
    focusArea: "Passing",
    purpose: "Teaches passing and moving to give support angles.",
    cue: "Pass, then move to a new angle.",
    summary:
      "Groups of three keep a triangle shape while passing and moving, working on support angles and quick give-and-go passes.",
    distinctFrom: [
      {
        number: 22,
        difference:
          "Drill 16 trains group shape and support angles in a rotating triangle of three. Drill 22 isolates the one-two between two players and progresses it with movement.",
      },
      {
        number: 8,
        difference:
          "Drill 8 is one player against a rebound surface; Drill 16 always involves three teammates.",
      },
    ],
    content: {
      description:
        "Three players stand in a triangle and pass the ball around it. After every pass the passer moves to a new angle to stay available, so the shape rotates. Quick wall-passes (a pass and a return) are used within the triangle. The focus is on group shape and the angles of support, not on one pair.",
      skills: ["Passing", "Support angles", "Movement", "Communication"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 12,
      players: { min: 3, max: 18, note: "Groups of three" },
      equipment: ["One ball per group", "Cones to mark each triangle"],
      setup: {
        layout:
          "Each group of three stands at the corners of a triangle marked with cones, with space between groups.",
        dimensions: DIM.grid,
      },
      steps: [
        "Player 1 passes to player 2, then moves to a new support angle.",
        "Player 2 passes to player 3 and also moves to a new angle.",
        "Keep the triangle shape while rotating around it, always giving the passer an angle.",
        "On the coach's call play a quick wall-pass: pass to a teammate and receive the return at once.",
        "Change the direction of rotation and swap positions regularly.",
      ],
      coachingPoints: [
        "Pass and move: never stand still after passing.",
        "Create a clear angle for the passer to play to.",
        "Use the inside of the foot with a firm ankle.",
        "Call for the ball and point to where you want it.",
      ],
      commonMistakes: [
        "Standing still after passing.",
        "Bunching up in a straight line.",
        "Passing without looking.",
      ],
      progressions: {
        easier: [
          "Pass and move at walking pace.",
          "Allow two touches.",
        ],
        harder: [
          "Limit to one touch.",
          "Add a defender in the middle.",
        ],
      },
      safety: [
        SAFE.space,
        SAFE.balls,
        SAFE.surface,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "triangle", "support", "give and go", "groups of three"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact triangle routine was located."),
      ],
      diagram: triangle({
        caption:
          "Three players pass around a triangle and move to new support angles after each pass.",
      }),
    },
  }),
  drill({
    number: 17,
    categoryId: cat,
    name: "Four-Corner Passing",
    originalObjective: "Vision, communication, and directional receiving.",
    focusArea: "Passing",
    purpose: "Builds vision, communication and receiving in the right direction.",
    cue: "Look, call and take your first touch forward.",
    summary:
      "Players pass between four corners in a set order, calling for the ball and receiving so they face the next pass.",
    content: {
      description:
        "Four players, one at each corner of a marked area, pass in a set order. After passing, the player follows the ball to the next corner. Players call for the ball, check their shoulders and set their first touch in the direction of the next pass.",
      skills: ["Passing", "Communication", "Scanning", "Directional first touch"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 10,
      players: { min: 4, max: 20, note: "Groups of four or more" },
      equipment: ["Four cones per group", "One ball per group"],
      setup: {
        layout:
          "A square marked with cones. A player stands at each corner; extra players wait behind a corner.",
        dimensions: DIM.grid,
      },
      steps: [
        "Player A passes to the player at the next corner (B) and follows the pass.",
        "B controls the ball with a touch that sets it towards the next corner and passes on.",
        "Continue around the square, each passer following their pass to the next corner.",
        "On the coach's call change the direction of passing or play a diagonal.",
        "Add a second ball when the group is confident.",
      ],
      coachingPoints: [
        "Call the receiver's name or say 'now' before passing.",
        "Check over the shoulder before the ball arrives.",
        "Open the body so the first touch moves the ball towards the next target.",
        "Pass firmly and accurately to the receiver's front foot.",
      ],
      commonMistakes: [
        "Passing without a call.",
        "Taking a touch that points the wrong way.",
        "Standing still at the corner.",
      ],
      progressions: {
        easier: [
          "Walk through the sequence.",
          "Allow two touches.",
        ],
        harder: [
          "One touch only.",
          "Two balls moving at once.",
        ],
      },
      safety: [
        "Pass at a controlled pace so receivers can handle the ball.",
        SAFE.space,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "communication", "scanning", "first touch"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact four-corner pattern was located."),
      ],
      diagram: grid({
        players: [
          P(28, 14, "A", "A"),
          P(72, 14, "A", "B"),
          P(72, 50, "A", "C"),
          P(28, 50, "A", "D"),
          Ball(31, 16),
          Pass(31, 14, 69, 14, 1),
          Pass(72, 17, 72, 47, 2),
          Pass(69, 50, 31, 50, 3),
          Pass(28, 47, 28, 17, 4),
          Run(32, 18, 66, 18, 5),
        ],
        caption:
          "Four players pass in order around a square and follow the pass to the next corner.",
        area: { x: 24, y: 10, w: 52, h: 44 },
      }),
    },
  }),
  drill({
    number: 18,
    categoryId: cat,
    name: "The Time Glass Passing Drill",
    originalObjective: "Timed combination sequences.",
    focusArea: "Passing",
    purpose: "Practises passing in a set order against the clock.",
    cue: "Quick, accurate passes in the right order.",
    summary:
      "Five players pass through an hourglass-shaped layout in a set sequence, in timed rounds.",
    interpretation:
      "Sportozen's defined interpretation, not an established historical drill: an hourglass-shaped passing layout (two triangles joined at a narrow waist) run in timed rounds. The name was not found as a recognised drill in the coaching sources searched.",
    content: {
      description:
        "Five players stand in an hourglass layout: two at the top, one in the middle (the waist) and two at the bottom. A fixed sequence of passes runs through the waist from top to bottom and back. The coach runs timed rounds and the group tries to complete the sequence accurately within each round. Accuracy comes first; speed grows as the group improves.",
      skills: ["Combination passing", "Accuracy under time", "Communication", "Rhythm"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 5, max: 15, note: "Groups of five" },
      equipment: ["Five cones per group", "One ball per group", "A timer or watch for the coach"],
      setup: {
        layout:
          "Five cones form an hourglass: two at the top, one at the waist and two at the bottom. One player stands at each cone.",
        dimensions: DIM.grid,
      },
      steps: [
        "Player 1 (top left) passes to the waist player (3).",
        "The waist player passes to player 5 (bottom right).",
        "Player 5 passes across the bottom to player 4, who returns the ball to the waist.",
        "The waist player passes to player 2 (top right), who passes back across the top to player 1 to complete one sequence.",
        "The coach starts and stops timed rounds; the group counts completed sequences without errors.",
        "Rotate positions after each round so everyone plays at the waist.",
      ],
      coachingPoints: [
        "Accuracy before speed.",
        "Call for the ball and say where it should go.",
        "Take a first touch that sets up the next pass.",
        "The waist player stays side-on to see both sides.",
      ],
      commonMistakes: [
        "Rushing and making mistakes.",
        "Passing to the wrong player in the sequence.",
        "Waist player facing only one way.",
      ],
      progressions: {
        easier: [
          "Remove the timer and focus on the sequence.",
          "Allow two touches.",
        ],
        harder: [
          "Shorter time for each round.",
          "One touch, or add a defender in the waist.",
        ],
      },
      safety: [
        "Timed rounds must not push players into reckless passing; the coach pauses the round if control is lost.",
        SAFE.space,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "combination", "timed", "hourglass", "sequence"],
      references: [
        limitation(
          "No recognised drill called 'Time Glass' was found. The closest published idea located by search was an 'Hour Glass Passing' session plan on a secondary site, which was not opened. This is Sportozen's defined interpretation.",
        ),
      ],
      diagram: hourglass({
        caption:
          "An hourglass of five players: passes run from the top, through the waist, across the bottom and back, in timed rounds.",
      }),
    },
  }),
  drill({
    number: 19,
    categoryId: cat,
    name: "Pass In, Pass Out",
    originalObjective: "Vertical entry and layoff combinations.",
    focusArea: "Passing",
    purpose: "Practises passing forward to a teammate and getting it back.",
    cue: "Play forward, then support the layoff.",
    summary:
      "A forward pass into a target player, a layoff to a supporting teammate and a pass out wide.",
    content: {
      description:
        "A passer plays a forward (vertical) ball into a target player. The target lays the ball off with one touch to a supporting teammate who has moved into position, and the supporting player passes out to the next player. It trains playing forward, laying off and quick support.",
      skills: ["Vertical passing", "Layoffs", "Support runs", "First touch"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 5, max: 15 },
      equipment: ["Cones", "Balls", "Bibs for the target players"],
      setup: {
        layout:
          "A marked channel with a passer at one end, a target player in the middle area, a supporting player to the side and a receiver on the other side.",
        dimensions: DIM.grid,
      },
      steps: [
        "The passer plays a firm forward pass into the target player.",
        "The target player controls or lays off first time to the supporting player.",
        "The supporting player, who has made a run to a good angle, plays the next pass out to the receiver.",
        "Players rotate positions: the passer becomes the target, then supports, then receives.",
        "Change the sequence on the coach's call, for example a longer or a shorter layoff.",
      ],
      coachingPoints: [
        "Pass firmly into the target's feet or the space next to them.",
        "The target opens the body so the layoff is clean.",
        "The supporting player arrives at an angle to receive, not behind the target.",
        "Communicate with calls such as 'turn' or 'lay it off'.",
      ],
      commonMistakes: [
        "Passing too softly into the target.",
        "Supporting player standing flat behind the target.",
        "Target turning away from the supporter.",
      ],
      progressions: {
        easier: [
          "Two touches for the target.",
          "No time pressure.",
        ],
        harder: [
          "Add a passive defender on the target.",
          "Limit to one touch for the target.",
        ],
      },
      safety: [
        "Pass at a controlled pace; keep players in their own roles to avoid collisions.",
        SAFE.space,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "layoff", "target player", "third player", "combination"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact pattern was located."),
      ],
      diagram: grid({
        players: [
          P(50, 52, "A", "1"),
          Ball(52, 50),
          P(50, 18, "N", "T"),
          P(26, 40, "A", "2"),
          P(76, 22, "A", "3"),
          Pass(50, 49, 50, 22, 1),
          Pass(48, 21, 28, 37, 2),
          Pass(30, 38, 73, 24, 3),
        ],
        caption:
          "The passer (1) plays forward to the target (T), who lays off to the supporter (2); the supporter passes out to (3).",
      }),
    },
  }),
  drill({
    number: 20,
    categoryId: cat,
    name: "Rotational Passing Combinations",
    originalObjective: "Overlap and third-man runs.",
    focusArea: "Off-the-ball movement",
    purpose: "Practises passing with runs by teammates to create space.",
    cue: "Pass, then run to the space someone just left.",
    summary:
      "A rotating passing pattern in which players make overlap and third-man runs after their pass.",
    content: {
      description:
        "A group passes in a repeating pattern and rotates positions. After passing, players make a run: an overlap run around a teammate, or a third-man run that goes beyond the pair passing. It trains reading teammates' movements and timing runs to arrive in space.",
      skills: ["Overlap runs", "Third-man runs", "Timing", "Combination play"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 4, max: 16, note: "Groups of four" },
      equipment: ["Cones", "One ball per group", "Bibs"],
      setup: {
        layout:
          "Groups of four in a marked rectangle: a passer, a receiver, a runner for the overlap and a third man further away.",
        dimensions: DIM.grid,
      },
      steps: [
        "The first player passes to the second player and starts an overlap run around them.",
        "The second player passes into the path of the overlapping runner.",
        "A third player, who started away from the ball, makes a run into space as the pass is played.",
        "Rotate roles so each player takes a turn as passer, receiver, overlapper and third man.",
        "Repeat on the other side so players practise both directions.",
      ],
      coachingPoints: [
        "The runner starts moving as the pass is played, not before.",
        "Pass into the runner's stride, not their feet.",
        "Communicate with a call such as 'over' or 'go'.",
        "Third-man runs begin from outside the passers' line of sight.",
      ],
      commonMistakes: [
        "Running too early and being offside in game terms.",
        "Passing to where the runner has been.",
        "Everyone stopping after their pass.",
      ],
      progressions: {
        easier: [
          "Walk through the pattern first.",
          "Practise without a defender.",
        ],
        harder: [
          "Add a passive defender.",
          "Limit touches.",
        ],
      },
      safety: [
        "Players run in set lanes to avoid collisions; the coach stops the pattern if runs cross.",
        SAFE.space,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "overlap", "third man", "combination", "movement"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact rotation was located."),
      ],
      diagram: layout(
        "triangle",
        "GRID",
        [
          Zone(14, 6, 72, 52),
          P(22, 46, "A", "1"),
          Ball(25, 44),
          P(44, 34, "A", "2"),
          P(78, 26, "A", "3"),
          Pass(25, 44, 42, 35, 1),
          Run(24, 50, 62, 42, 2),
          Pass(46, 36, 60, 41, 3),
          Run(78, 24, 66, 10, 4),
          Text(50, 61, "1 passes and overlaps; 3 is the third man running into space"),
        ],
        "A rotating pattern: the first player passes and overlaps; a third player runs into the space created.",
      ),
    },
  }),
  drill({
    number: 21,
    categoryId: cat,
    name: "Diagonal & Straight Passing",
    originalObjective: "Pace control and body shaping.",
    focusArea: "Passing",
    purpose: "Builds control of how hard to pass and how to shape the body.",
    cue: "Shape your body, then choose the right pace.",
    summary:
      "Players pass straight and diagonally in two lines, controlling the weight of each pass and opening the body to receive.",
    content: {
      description:
        "Two lines of players face each other. They pass straight across and diagonally to the next player in the opposite line, then run to the end of the other line. The practice trains choosing the pace of the pass and shaping the body before receiving.",
      skills: ["Weight of pass", "Body shape", "Receiving", "Passing technique"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 10,
      players: { min: 6, max: 20 },
      equipment: ["Cones for two lines", "One or two balls"],
      setup: {
        layout:
          "Two facing lines marked with cones, with a gap between them and room at the end of each line.",
        dimensions: DIM.lane,
      },
      steps: [
        "The first player in line A passes straight to the first player in line B.",
        "They then pass diagonally to the second player in line B.",
        "Each passer runs to the end of the opposite line after passing.",
        "Alternate straight and diagonal passes; call the type before each pass.",
        "Change feet and change the surface of the foot used for the pass.",
      ],
      coachingPoints: [
        "Open the body so you can see the passer and the next target.",
        "Match the pace of the pass to the distance.",
        "Receive on the back foot to open up.",
        "Follow through towards the target.",
      ],
      commonMistakes: [
        "Passing every ball at the same pace.",
        "Closed body shape that blocks the view.",
        "Not moving after passing.",
      ],
      progressions: {
        easier: [
          "Shorter gaps and straight passes only.",
          "Two touches.",
        ],
        harder: [
          "One touch, longer diagonals.",
          "Add a time target for the sequence.",
        ],
      },
      safety: [
        "Players cross the gap only when the pass has been played, and watch other runners.",
        SAFE.space,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "diagonal", "weight of pass", "body shape", "lines"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact two-line pattern was located."),
      ],
      diagram: layout(
        "grid",
        "GRID",
        [
          Zone(8, 8, 84, 48),
          P(20, 18, "A"),
          P(20, 46, "A"),
          P(80, 18, "B"),
          P(80, 46, "B"),
          Ball(23, 20),
          Pass(23, 20, 77, 20, 1),
          Pass(23, 46, 77, 22, 2),
          Run(24, 17, 76, 47),
        ],
        "Two facing lines pass straight and diagonally, then each passer runs to the end of the opposite line.",
      ),
    },
  }),
  drill({
    number: 22,
    categoryId: cat,
    name: "Wall Pass (One-Two) Progression",
    originalObjective: "Dynamic wall-passes on the move.",
    focusArea: "Passing",
    purpose: "Practises the one-two pass with a teammate while moving.",
    cue: "Pass, move into space and take the return.",
    summary:
      "Pairs play a one-two with a teammate acting as the wall, progressing from standing to moving to beating a defender.",
    distinctFrom: [
      {
        number: 8,
        difference:
          "Drill 8 uses a passive rebound surface and trains first touch and accuracy in place. Drill 22 uses a teammate as the wall and trains movement and timing around the pass.",
      },
      {
        number: 16,
        difference:
          "Drill 16 works on a three-player shape and support angles. Drill 22 isolates the pair's one-two and builds it up step by step.",
      },
    ],
    content: {
      description:
        "Two players work together: the first passes to a teammate who acts as the 'wall', then runs into space past a defender (a cone at first) to receive the return pass. The progression moves from a stationary one-two, to a moving one-two, to a one-two beating a passive defender. Timing, weight of pass and the run after the pass are the focus.",
      skills: ["One-two passing", "Timing", "Movement", "Weight of pass"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 2, max: 16, note: "Pairs, with a defender in later stages" },
      equipment: ["Cones as defenders", "One ball per pair", "Bibs"],
      setup: {
        layout:
          "Pairs in short lanes. A cone (the defender) stands between the passer and the target space.",
        dimensions: DIM.lane,
      },
      steps: [
        "Stage 1: pass to your partner (the wall), who returns the ball first time; stay where you are.",
        "Stage 2: pass, then run into space beside the cone, and take the return in your stride.",
        "Stage 3: replace the cone with a passive defender; pass, run past the defender and receive the return.",
        "Stage 4: the wall player gets a second touch only if needed, and the defender begins to react.",
        "Swap roles so both players are passer and wall.",
      ],
      coachingPoints: [
        "Pass firmly, then move straight away.",
        "The wall player opens the body and returns the ball into the runner's path.",
        "Disguise the pass by looking away or dropping a shoulder.",
        "Accelerate after receiving.",
      ],
      commonMistakes: [
        "Waiting to watch the pass.",
        "The return pass behind the runner.",
        "Running too early or too late.",
      ],
      progressions: {
        easier: [
          "Stationary one-two with no defender.",
          "Allow two touches for the wall.",
        ],
        harder: [
          "Use a reactive defender.",
          "Link two one-twos in a row.",
        ],
      },
      safety: [
        "The defender stays passive until the coach says otherwise, with no tackling.",
        SAFE.space,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["passing", "one-two", "give and go", "pairs", "movement"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact progression was located."),
      ],
      diagram: layout(
        "grid",
        "LANE",
        [
          Zone(8, 14, 84, 36),
          P(18, 32, "A", "1"),
          Ball(21, 32),
          C(48, 32),
          P(48, 48, "A", "W"),
          Pass(22, 32, 46, 46, 1),
          Run(22, 30, 62, 20, 2),
          Pass(50, 46, 62, 24, 3),
          Run(64, 20, 88, 20, 4),
          Text(48, 12, "Passive defender (cone)"),
        ],
        "Player 1 passes to the wall player (W), runs past the defender and receives the return pass on the move.",
      ),
    },
  }),
  drill({
    number: 23,
    categoryId: cat,
    name: "Receiving in Midfield Under Pressure",
    originalObjective: "Scanning and turning forward.",
    focusArea: "Scanning",
    purpose: "Teaches checking before receiving and turning forward.",
    cue: "Scan, receive and turn forward.",
    summary:
      "A midfielder scans before receiving with a defender close behind, then turns and plays forward.",
    content: {
      description:
        "A midfield player receives a pass with a defender nearby. Before the ball arrives the player scans over the shoulder to see pressure and space, takes a first touch that turns them forward, and then passes to a target player. It builds scanning habits and the ability to turn under light pressure.",
      skills: ["Scanning", "Turning", "First touch", "Decision-making"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 4, max: 16 },
      equipment: ["Cones", "Balls", "Bibs", "Small goals or target cones"],
      setup: {
        layout:
          "A midfield zone with a passer behind, the receiver in the middle with a defender close behind, and a target player ahead.",
        dimensions: DIM.grid,
      },
      steps: [
        "The passer plays into the receiver's feet.",
        "The receiver scans over the shoulder before the ball arrives, checking where the defender is.",
        "With the first touch, turn away from pressure so the body faces forward.",
        "Pass forward to the target player or dribble into space.",
        "Rotate roles every few turns.",
      ],
      coachingPoints: [
        "Scan twice before the ball arrives.",
        "Use the first touch to turn, not just to stop the ball.",
        "Keep the ball on the side away from the defender.",
        "Decide early: turn, shield or play back.",
      ],
      commonMistakes: [
        "Receiving with the back to play without checking.",
        "A heavy first touch into pressure.",
        "Turning into the defender.",
      ],
      progressions: {
        easier: [
          "Defender begins passive.",
          "Receiver may take a second touch.",
        ],
        harder: [
          "Active but fair defender.",
          "Time-limit the turn.",
        ],
      },
      safety: [
        SAFE.contact,
        "Defenders challenge fairly for the ball and avoid contact from behind.",
        SAFE.space,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["receiving", "scanning", "turning", "midfield", "pressure"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact practice was located."),
      ],
      diagram: layout(
        "grid",
        "GRID",
        [
          Zone(18, 6, 64, 52),
          P(50, 54, "A", "1"),
          Ball(52, 52),
          P(50, 32, "A", "R"),
          P(50, 40, "B"),
          P(50, 10, "N", "T"),
          Pass(50, 51, 50, 35, 1),
          Run(50, 32, 38, 26, 2),
          Pass(40, 26, 50, 13, 3),
        ],
        "The receiver (R) scans, takes the pass under light pressure from the defender (B), turns and passes forward to the target (T).",
      ),
    },
  }),
  drill({
    number: 24,
    categoryId: cat,
    name: "Long-Ball Aerial Control",
    originalObjective: "Cushioning high balls with chest or foot.",
    focusArea: "First touch and receiving",
    purpose: "Builds control of high balls using the chest or foot.",
    cue: "Get under it and cushion the ball.",
    summary:
      "Players control high, lofted balls using only the chest or foot, cushioning them so they drop close.",
    interpretation:
      "Chest and foot control only. No heading, not even as an alternative; the practice is deliberately limited to the chest and foot.",
    content: {
      description:
        "A server plays a lofted ball to the receiver, who moves into the line of flight and controls it with the chest or the foot, cushioning it so it drops close to their feet. The receiver then passes to a teammate. The height of service is set to the age and skill of the group, starting low. Control is with the chest, thigh or foot only.",
      skills: ["Aerial control", "Cushioning", "First touch", "Judging the flight"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 3, max: 15, note: "Groups of three: server, receiver, target" },
      equipment: [
        "Lightweight balls suited to the age group",
        "Cones to mark each receiving box",
      ],
      setup: {
        layout:
          "A receiving box marked with cones. The server stands at one end, the receiver in the box and a target player to the side.",
        dimensions: DIM.grid,
      },
      steps: [
        "The server plays a gentle lofted ball into the receiving box.",
        "The receiver moves into the line of the ball and watches it into the contact surface.",
        "Cushion the ball with the chest, thigh or foot by relaxing and drawing the surface back on contact.",
        "Play the next ball to the target player with a short pass.",
        "Rotate roles every few turns.",
      ],
      coachingPoints: [
        "Get your body in line with the ball early.",
        "Watch the ball all the way onto the contact surface.",
        "Relax the contact surface and withdraw it slightly to cushion.",
        "Look up after the control to see the next pass.",
      ],
      commonMistakes: [
        "Stiff body so the ball bounces away.",
        "Moving late into the flight.",
        "Looking at the target instead of the ball.",
      ],
      progressions: {
        easier: [
          "Underarm, low service from the server's hands.",
          "Let the ball bounce once first.",
        ],
        harder: [
          "Lofted service with more height.",
          "Control and pass in one movement.",
        ],
      },
      safety: [
        "Control is by chest, thigh or foot only; heading is not part of this drill and no instruction is given for it.",
        "Keep service low and gentle for younger groups and use a lighter ball so it never arrives at the face.",
        "Check the receiving box is clear and the server waits for the receiver to be ready.",
      ],
      phase: "MAIN",
      intensity: "LOW",
      tags: ["aerial control", "chest control", "first touch", "long ball", "lofted"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact practice was located; no heights or distances are specified."),
      ],
      diagram: layout(
        "grid",
        "GRID",
        [
          Zone(40, 8, 24, 30, "Receiving box"),
          C(40, 8),
          C(64, 8),
          C(40, 38),
          C(64, 38),
          P(52, 56, "A", "S"),
          Ball(54, 54),
          P(52, 24, "A", "R"),
          P(76, 20, "N", "T"),
          Pass(52, 52, 52, 28, 1),
          Pass(54, 24, 74, 21, 2),
          Text(52, 62, "Server plays a gentle lofted ball"),
        ],
        "A server plays a lofted ball into the receiving box; the receiver controls with the chest or foot and passes to the target.",
      ),
    },
  }),
];
