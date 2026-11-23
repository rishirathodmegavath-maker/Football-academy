import type { UniversalDrill } from "@/domain/drill-library";
import {
  Ball,
  C,
  Drib,
  Goal,
  Mark,
  P,
  Pass,
  Run,
  Text,
  Zone,
  layout,
  shootingLane,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "shooting-crossing-finishing" as const;

const shootingSafety = [
  SAFE.goal,
  "One player shoots at a time; the next waits until the shot is taken and the area is clear.",
  "Players waiting stand behind and to the side of the shooting area, never in front of the goal.",
  "Goalkeepers, if used, are optional and may wear gloves and appropriate protection for their age.",
];

export const shootingCrossingFinishing: UniversalDrill[] = [
  drill({
    number: 34,
    categoryId: cat,
    name: "Hurdle Shooting",
    originalObjective: "Jumping and striking low, driven shots.",
    focusArea: "Finishing",
    purpose: "Practises striking a low, driven shot after a controlled jump.",
    cue: "Land balanced, then strike low and firm.",
    summary:
      "Players jump over low, soft hurdles or flat markers, regain balance on landing and then strike a low, driven shot at goal.",
    interpretation:
      "Redesigned for safety: hurdles are low, soft or collapsible (or flat markers for younger players), with a clear landing area. The shot is taken only after balance is regained, never in the air.",
    content: {
      description:
        "Each player jumps over one or two low, soft hurdles (or steps over flat markers), lands on both feet with balance, then takes a controlled run onto a ball and strikes a low, driven shot at goal. The jump builds athletic coordination; the shot is struck only once the player is balanced. One player works at a time in a clear lane.",
      skills: ["Finishing", "Low driven shots", "Balance on landing", "Coordination"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 4, max: 14 },
      equipment: [
        "Low, soft or collapsible hurdles, or flat markers for younger players",
        "A goal (anchored)",
        "Balls",
        "Cones to mark the lane and the landing area",
      ],
      setup: {
        layout:
          "A lane leading to a goal: a start position, one or two hurdles or flat markers, a marked landing area, and the ball placed beyond the landing area. Waiting players stand to the side, outside the shooting line.",
        dimensions:
          "The coach sets the hurdle height, spacing and landing area to the age and ability of the group, so every player clears the hurdles comfortably and has a clear, flat landing area. The coach checks the clearances and the lane before starting.",
      },
      steps: [
        "The first player starts at the start line while the others wait to the side.",
        "Jump over (or step over) the hurdle or markers, landing on both feet.",
        "Check balance on landing: pause for a moment, then move to the ball.",
        "Strike a low, driven shot at the goal with the laces, only after balance is regained.",
        "Collect the ball safely (or a coach feeds a new one) and move to the back of the line. The next player starts only when the area is clear.",
      ],
      coachingPoints: [
        "Land softly on both feet with the knees bent.",
        "Settle and balance before you strike.",
        "Plant the standing foot beside the ball and strike through its centre to keep it low.",
        "Keep your head steady and eyes on the ball, then on the target.",
      ],
      commonMistakes: [
        "Rushing the shot before balance is regained.",
        "Leaning back and lifting the ball over the bar.",
        "Setting the hurdles too high or too close together.",
      ],
      progressions: {
        easier: [
          "Use flat markers instead of hurdles.",
          "Take more time to settle before the shot.",
        ],
        harder: [
          "Add a second hurdle.",
          "Add a passive goalkeeper.",
        ],
      },
      safety: [
        "Use low, soft or collapsible hurdles, or flat markers, never rigid or high obstacles.",
        "Keep a clear landing area and a flat, dry surface; check the lane before each round.",
        "Shoot only after balance is regained, never while airborne or off balance.",
        ...shootingSafety,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["shooting", "finishing", "hurdles", "driven shot", "coordination"],
      references: [
        REF.fifaFinish,
        limitation(
          "The FIFA finishing page was located by search but could not be opened. No source for the hurdle element was located; hurdle height, spacing and distances are left to the coach.",
        ),
      ],
      diagram: shootingLane({
        hurdles: 2,
        caption:
          "A lane with two low soft hurdles, a landing area and a goal. The shot is taken after landing; waiting players stand to the side.",
      }),
    },
  }),
  drill({
    number: 35,
    categoryId: cat,
    name: "Half-Field Combinations to Finish",
    originalObjective: "Build-up ending in a strike.",
    focusArea: "Finishing",
    purpose: "Practises building an attack and finishing with a shot.",
    cue: "Combine, create space and strike.",
    summary:
      "Small groups combine in the half pitch with passes and runs, then finish with a shot on goal.",
    content: {
      description:
        "Groups of three or four attack the goal from the halfway area. They combine with quick passes and supporting runs, then finish with a shot. Defenders may be added later. It links build-up play to finishing.",
      skills: ["Combination play", "Finishing", "Movement", "Decision-making"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 6, max: 16 },
      equipment: ["Goal(s)", "Balls", "Cones", "Bibs"],
      setup: {
        layout:
          "A half pitch with a goal. The attacking group starts near the halfway line; a goalkeeper is optional.",
        dimensions: DIM.half,
      },
      steps: [
        "The group starts with a pass from the halfway line area.",
        "Combine with quick passes and supporting runs towards the goal.",
        "Finish with a shot from a good position.",
        "Collect the ball, return to the start and rotate positions.",
        "Add a passive defender, then a live one, as the group improves.",
      ],
      coachingPoints: [
        "Pass and move to create angles.",
        "Use the first touch to move towards goal.",
        "Shoot early when the chance arrives.",
        "Follow the shot for any rebound.",
      ],
      commonMistakes: [
        "Too many touches before the shot.",
        "Shooting from poor angles.",
        "Standing still after passing.",
      ],
      progressions: {
        easier: [
          "No defenders and unlimited touches.",
          "Shorter build-up.",
        ],
        harder: [
          "Add defenders.",
          "Limit touches or add a time limit.",
        ],
      },
      safety: shootingSafety,
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["finishing", "combination", "attacking", "half pitch"],
      references: [
        REF.fifaFinish,
        limitation("The FIFA page was located by search but could not be opened."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          P(50, 6, "GK"),
          P(24, 50, "A", "1"),
          Ball(27, 48),
          P(48, 40, "A", "2"),
          P(72, 46, "A", "3"),
          Pass(27, 48, 46, 41, 1),
          Pass(48, 38, 70, 44, 2),
          Run(70, 44, 58, 20, 3),
          Pass(58, 20, 52, 5, 4),
        ],
        "Three attackers combine with passes and runs from midfield, then finish with a shot at the goal.",
      ),
    },
  }),
  drill({
    number: 36,
    categoryId: cat,
    name: "Crossing and Finishing",
    originalObjective: "Winger delivery with near/far-post runs.",
    focusArea: "Finishing",
    purpose: "Practises crosses from the wing and finishing them.",
    cue: "Deliver early and attack the near and far post.",
    summary:
      "A winger crosses from wide while two attackers run to the near and far post to finish.",
    content: {
      description:
        "A winger dribbles down the flank and delivers a cross. Two or more attackers make timed runs to the near and far post and try to finish the cross. A goalkeeper is optional. It trains the quality of delivery and the movement of attackers in the penalty area.",
      skills: ["Crossing", "Finishing", "Timing of runs", "Communication"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 6, max: 16 },
      equipment: ["Goal", "Balls", "Cones to mark the wing", "Bibs"],
      setup: {
        layout:
          "A half pitch with a goal. A wide channel on each wing for the crossers and an area in front of goal for the finishers.",
        dimensions: DIM.half,
      },
      steps: [
        "The winger starts with the ball in the wide channel and dribbles towards the byline.",
        "As the winger approaches, the finishers start runs: one to the near post, one to the far post.",
        "The winger delivers a cross into the area.",
        "Finishers attack the ball and try to score.",
        "Rotate roles, and swap to the other wing.",
      ],
      coachingPoints: [
        "Cross early and with pace, away from the keeper.",
        "Near-post runner attacks the front; far-post runner arrives later.",
        "Time the runs so they are moving as the ball is crossed.",
        "Strike with control: low and across goal where possible.",
      ],
      commonMistakes: [
        "Runners arriving too early.",
        "Crossing too high or too far.",
        "Finishers standing and waiting.",
      ],
      progressions: {
        easier: [
          "No goalkeeper and unlimited touches.",
          "Cross from a standing position.",
        ],
        harder: [
          "Add a defender.",
          "One-touch finish only.",
        ],
      },
      safety: [
        "Finishers strike with the feet or other safe contact; contact with the keeper is avoided.",
        ...shootingSafety,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["crossing", "finishing", "wing play", "runs", "attacking"],
      references: [
        REF.fifaFinish,
        REF.uefaGrassroots,
        limitation("The FIFA page was located by search but could not be opened."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          P(50, 6, "GK"),
          P(88, 50, "A", "W"),
          Ball(86, 50),
          Drib(86, 48, 86, 14, 1),
          Pass(86, 12, 56, 12, 2),
          P(44, 34, "A", "N"),
          P(60, 36, "A", "F"),
          Run(44, 32, 48, 14, 3),
          Run(60, 34, 56, 14, 4),
          Text(50, 60, "N = near post run, F = far post run"),
        ],
        "A winger (W) crosses from the wing while attackers run to the near post (N) and far post (F).",
      ),
    },
  }),
  drill({
    number: 37,
    categoryId: cat,
    name: "Corner-Restricted 2v2",
    originalObjective: "Tight-space goal-scoring under pressure.",
    focusArea: "Finishing",
    purpose: "Practises scoring and defending in a small, crowded space.",
    cue: "Be quick and brave in tight space.",
    summary:
      "A 2v2 game played in a restricted corner area with a goal, building quick thinking in tight space.",
    interpretation:
      "A 2v2 played in a small marked zone in the corner of the pitch, with a goal to attack.",
    content: {
      description:
        "Two teams of two play in a small restricted zone in a corner of the pitch, attacking a goal. The limited space forces quick passing, sharp turns and rapid shots. It trains scoring and defending under pressure.",
      skills: ["Finishing under pressure", "Quick decisions", "1v1 and 2v2 play", "Turning"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 4, max: 12 },
      equipment: ["Cones to mark the corner zone", "Goal or mini-goal", "Balls", "Bibs"],
      setup: {
        layout:
          "A small zone marked in the corner of the pitch with a goal on its far side. Extra players wait outside.",
        dimensions: DIM.half,
      },
      steps: [
        "Two attackers start with the ball against two defenders in the corner zone.",
        "Attackers try to score in the goal; defenders try to win the ball and clear it.",
        "When the ball is won, play on or restart with the next pair.",
        "Rotate pairs after each period.",
        "Reduce the zone size to raise the pressure.",
      ],
      coachingPoints: [
        "Quick, short passes and sharp turns.",
        "Shoot when you see a gap.",
        "Defenders work together and block the shooting lane.",
        "Stay calm in tight space.",
      ],
      commonMistakes: [
        "Dribbling into a dead end.",
        "Both defenders attacking the ball.",
        "Hesitating to shoot.",
      ],
      progressions: {
        easier: [
          "Bigger zone.",
          "Passive defenders.",
        ],
        harder: [
          "Smaller zone.",
          "Limit touches.",
        ],
      },
      safety: [SAFE.contact, ...shootingSafety],
      phase: "GAME",
      intensity: "HIGH",
      tags: ["2v2", "finishing", "small-sided", "pressure", "corner"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact corner-restricted format was located."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Zone(58, 14, 38, 44, "Corner zone"),
          Goal(94, 24, 3, 18),
          P(66, 44, "A"),
          P(78, 28, "A"),
          P(72, 36, "B"),
          P(84, 46, "B"),
          Ball(68, 42),
          Pass(68, 42, 78, 31, 1),
          Pass(79, 28, 93, 32, 2),
          C(58, 14),
          C(96, 14),
          C(58, 58),
          C(96, 58),
        ],
        "A 2v2 in a restricted corner zone: the attackers (A) try to score past the defenders (B).",
      ),
    },
  }),
  drill({
    number: 38,
    categoryId: cat,
    name: "World Cup Shooting Game",
    originalObjective: "Knockout finishing competition.",
    focusArea: "Finishing",
    purpose: "A fun shooting competition that rewards good finishing.",
    cue: "Stay relaxed and aim for the corners.",
    summary:
      "A points-based shooting competition with a World Cup theme: players score points rather than being knocked out.",
    interpretation:
      "A World Cup themed competition played in rounds. To keep everyone involved, scoring is points-based and rounds advance the leaders without leaving anyone standing idle for long.",
    content: {
      description:
        "Players are given team or country names and shoot in rounds at a goal. Each round, players score points for goals and for good finishing, and the leaders advance to a final round. Everyone keeps playing: those who do not advance take part in a short side game or act as ball collectors. The competition is for fun and repeated finishing practice.",
      skills: ["Finishing", "Composure", "Shot selection", "Competition"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 14,
      players: { min: 6, max: 20 },
      equipment: ["Goal(s)", "Balls", "Cones", "A scoreboard or notebook"],
      setup: {
        layout:
          "A goal with a shooting area marked in front of it. Players queue to one side, each with a country name.",
        dimensions: DIM.half,
      },
      steps: [
        "Give each player a team or country name and explain the points system.",
        "In each round players take turns to shoot from the marked area.",
        "Score points for goals; award bonus points for placing the ball in a corner.",
        "The leaders move on to the final round while the rest play a short side game or collect balls.",
        "Finish with a final round and celebrate the winners.",
      ],
      coachingPoints: [
        "Pick a corner and strike through the ball.",
        "Stay relaxed under pressure.",
        "Keep your head down at contact.",
        "Support your teammates and enjoy the competition.",
      ],
      commonMistakes: [
        "Trying to hit the ball too hard and losing accuracy.",
        "Lacking a plan for where to shoot.",
        "Mocking a teammate's missed shot.",
      ],
      progressions: {
        easier: [
          "Shoot from a closer area.",
          "No goalkeeper.",
        ],
        harder: [
          "Add a goalkeeper or a defender.",
          "Shoot from varied angles.",
        ],
      },
      safety: shootingSafety,
      phase: "GAME",
      intensity: "LOW",
      tags: ["shooting", "competition", "finishing", "fun", "points"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact game was located."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          P(50, 6, "GK"),
          Zone(36, 26, 28, 16, "Shooting area"),
          P(50, 34, "A"),
          Ball(52, 36),
          Pass(52, 34, 58, 5, 1),
          P(80, 44, "A"),
          P(86, 44, "A"),
          P(92, 44, "A"),
          Text(86, 56, "Waiting"),
        ],
        "Players take turns to shoot from the marked area; the others wait to the side.",
      ),
    },
  }),
  drill({
    number: 39,
    categoryId: cat,
    name: "Midfield Goals Transition",
    originalObjective: "Spreading attack and quick strike.",
    focusArea: "Positioning",
    purpose: "Practises switching quickly from defending to attacking.",
    cue: "Spread out and strike quickly after winning the ball.",
    summary:
      "Two teams play with small goals on the halfway line, spreading wide to attack and striking quickly after winning the ball.",
    interpretation:
      "Small goals are placed on the halfway line so teams attack towards the middle of the pitch, which encourages spreading wide and quick strikes after a turnover.",
    content: {
      description:
        "Two teams play a transition game on a pitch with small goals set on the halfway line. After winning the ball a team spreads its players wide and tries to strike quickly at the nearest open goal. The setup rewards quick thinking after a turnover.",
      skills: ["Transition", "Spreading the attack", "Quick finishing", "Positioning"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 8, max: 20 },
      equipment: ["Two small goals", "Cones", "Balls", "Bibs"],
      setup: {
        layout:
          "A pitch with small goals on the halfway line, facing the two ends. Two teams in different colours.",
        dimensions: DIM.half,
      },
      steps: [
        "The two teams play with the objective of scoring in either small goal.",
        "When a team wins the ball, players spread wide quickly.",
        "Look for the fastest route to a shot at the nearest open goal.",
        "Restart after each goal with the other team.",
        "Rotate teams and positions regularly.",
      ],
      coachingPoints: [
        "Spread wide as soon as you win the ball.",
        "Look up to see the open goal and the free teammates.",
        "Strike early when there is a chance.",
        "On losing the ball, recover quickly to protect the goal.",
      ],
      commonMistakes: [
        "Clustering after winning the ball.",
        "Dribbling into traffic instead of passing.",
        "Not recovering when the ball is lost.",
      ],
      progressions: {
        easier: [
          "Bigger goals.",
          "More space.",
        ],
        harder: [
          "Smaller goals.",
          "Three-touch limit.",
        ],
      },
      safety: [...shootingSafety, SAFE.contact],
      phase: "GAME",
      intensity: "HIGH",
      tags: ["transition", "small-sided", "midfield goals", "quick strike"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact layout was located."),
      ],
      diagram: layout(
        "grid",
        "PITCH",
        [
          Goal(48, 14, 4, 8),
          Goal(48, 42, 4, 8),
          Zone(4, 4, 92, 56),
          P(20, 14, "A"),
          P(28, 32, "A"),
          P(20, 50, "A"),
          P(80, 18, "B"),
          P(72, 34, "B"),
          P(80, 48, "B"),
          Ball(30, 30),
          Pass(30, 30, 22, 16, 1),
          Run(20, 14, 42, 18, 2),
          Pass(24, 15, 46, 18, 3),
        ],
        "Two teams attack small goals on the halfway line, spreading wide and striking quickly after a turnover.",
      ),
    },
  }),
  drill({
    number: 40,
    categoryId: cat,
    name: "End-Line Target Games",
    originalObjective: "Flank play and cutbacks.",
    focusArea: "Passing",
    purpose: "Practises attacking down the wing and passing back across goal.",
    cue: "Get to the end line and pull the ball back.",
    summary:
      "Attackers work the ball to the end line and pass to a target or cut the ball back for a teammate to finish.",
    content: {
      description:
        "Attackers dribble or pass the ball down the flank to the end line. From there they play the ball to a target player on the end line, or pull it back across goal for a teammate to finish. It trains flank play and the cutback, a common route to goal.",
      skills: ["Wing play", "Cutbacks", "Crossing low", "Finishing"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 6, max: 16 },
      equipment: ["Goal", "Balls", "Cones to mark the end line and wings", "Bibs"],
      setup: {
        layout:
          "A half pitch with a goal. Target players stand on the end line, and attackers start wide.",
        dimensions: DIM.half,
      },
      steps: [
        "An attacker starts wide with the ball and runs towards the end line.",
        "Reaching the end line, the attacker either passes to a target player or cuts the ball back.",
        "A teammate arrives at the edge of the area and finishes the cutback.",
        "Rotate attackers, finishers and target players.",
        "Add a defender when the group is confident.",
      ],
      coachingPoints: [
        "Get to the end line before delivering.",
        "Pull the ball back low and along the ground.",
        "Finishers arrive late into the space.",
        "The target player shows for the ball and passes first time.",
      ],
      commonMistakes: [
        "Crossing from too deep too early.",
        "Finishers arriving too early.",
        "Cutbacks that are too high or too hard.",
      ],
      progressions: {
        easier: [
          "No defender.",
          "Cutback to a stationary teammate.",
        ],
        harder: [
          "Add a defender.",
          "One-touch finishes only.",
        ],
      },
      safety: shootingSafety,
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["wing play", "cutback", "end line", "target", "finishing"],
      references: [
        REF.fifaFinish,
        limitation("The FIFA page was located by search but could not be opened."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          P(50, 6, "GK"),
          Zone(10, 2, 80, 6, "End line"),
          P(88, 52, "A", "1"),
          Ball(86, 52),
          Drib(86, 50, 86, 12, 1),
          Pass(84, 10, 60, 24, 2),
          P(58, 28, "A", "2"),
          Pass(58, 26, 52, 8, 3),
          P(24, 6, "N", "T"),
          Mark(88, 60, "Start"),
        ],
        "An attacker runs to the end line and cuts the ball back to a teammate arriving at the edge of the area to finish.",
      ),
    },
  }),
];
