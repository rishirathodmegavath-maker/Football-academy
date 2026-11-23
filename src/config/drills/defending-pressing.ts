import type { UniversalDrill } from "@/domain/drill-library";
import {
  Ball,
  C,
  Goal,
  P,
  Pass,
  Run,
  Text,
  Zone,
  grid,
  layout,
  threeTeamRotation,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "defending-pressing" as const;

const defendingSafety = [
  SAFE.contact,
  "Challenges are fair and for the ball only; the coach stops play at once for any rough or dangerous challenge.",
  SAFE.water,
];

export const defendingPressing: UniversalDrill[] = [
  drill({
    number: 41,
    categoryId: cat,
    name: "1v1 into 2v2 and 3v3 Progression",
    originalObjective: "Incremental defensive recovery.",
    focusArea: "Defending",
    purpose: "Builds defending skills step by step, from one to three defenders.",
    cue: "Stay balanced, delay and work together.",
    summary:
      "A defending progression that grows from 1v1 to 2v2 and 3v3, practising delaying, covering and recovering.",
    interpretation:
      "'Recovery' means defensive recovery: getting back into position, covering teammates and regaining shape as numbers grow. It does not mean physical rest.",
    content: {
      description:
        "The practice starts as a 1v1 with a goal to defend. When the attacker is beaten or the ball is won, a second pair joins to make 2v2, and then a third pair for 3v3. Defenders practise delaying, jockeying, covering a teammate and recovering position as the numbers increase.",
      skills: ["Defending 1v1", "Covering", "Recovery runs", "Communication"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 6, max: 18 },
      equipment: ["Small goals or cones", "Balls", "Bibs", "Cones to mark the area"],
      setup: {
        layout:
          "A marked area with a goal at one end. Pairs queue to start; extra pairs wait to join as the numbers grow.",
        dimensions: DIM.grid,
      },
      steps: [
        "Start with a 1v1: the attacker tries to score and the defender delays and tries to win the ball.",
        "After a set time or when the ball is won or lost, the next pair joins to make a 2v2.",
        "Defenders now cover each other: one pressures, one covers behind.",
        "Add a third pair for a 3v3 and focus on communication and shape.",
        "Rotate pairs between attacking and defending and begin again from 1v1.",
      ],
      coachingPoints: [
        "Stay on your feet, side-on and balanced; do not dive in.",
        "Force the attacker to one side and delay them.",
        "The covering defender stays behind and talks.",
        "Recover quickly into a compact shape.",
      ],
      commonMistakes: [
        "Diving in too early.",
        "Defenders standing flat in line.",
        "Not communicating who presses and who covers.",
      ],
      progressions: {
        easier: [
          "Passive attackers.",
          "Only 1v1 and 2v2.",
        ],
        harder: [
          "Add a time limit for the attackers.",
          "Add a target goalkeeper.",
        ],
      },
      safety: defendingSafety,
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["defending", "1v1", "2v2", "3v3", "progression", "recovery"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact progression was located."),
      ],
      diagram: layout(
        "grid",
        "GRID",
        [
          Zone(18, 6, 64, 52),
          Goal(40, 4, 20),
          P(40, 22, "B", "1"),
          P(50, 44, "A", "1"),
          Ball(52, 42),
          Run(50, 42, 50, 26, 1),
          Run(40, 24, 46, 32, 2),
          Text(50, 61, "Stage 1 (1v1) shown; add a pair for 2v2, then 3v3"),
        ],
        "Stage 1 shown: a 1v1 against a goal; a second and third pair join later for 2v2 and 3v3.",
      ),
    },
  }),
  drill({
    number: 42,
    categoryId: cat,
    name: "2v1 Defending When Outnumbered",
    originalObjective: "Delaying and jockeying.",
    focusArea: "Defending",
    purpose: "Teaches a defender how to delay when outnumbered.",
    cue: "Slow them down and wait for help.",
    summary:
      "One defender faces two attackers and practises delaying and jockeying until help arrives.",
    distinctFrom: [
      {
        number: 44,
        difference:
          "Drill 42 is one defender delaying two attackers. Drill 44 is a larger block-organisation game with several goals.",
      },
    ],
    content: {
      description:
        "Two attackers advance on a single defender towards a small goal. The defender cannot win the ball by force; instead they delay the attackers, shepherd them wide and wait for a recovering teammate or the end of the time. It trains patience and jockeying when outnumbered.",
      skills: ["Delaying", "Jockeying", "Patience", "Positioning"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 6, max: 15 },
      equipment: ["Small goal or cones", "Balls", "Bibs", "Cones to mark the lane"],
      setup: {
        layout:
          "A short channel with a small goal at one end. Two attackers start with the ball; a defender starts in front of the goal; a recovering defender waits behind the attackers.",
        dimensions: DIM.grid,
      },
      steps: [
        "The two attackers advance with the ball towards the goal.",
        "The defender delays, backing off slowly and keeping goalside.",
        "Force the attackers wide and make them slow down.",
        "The recovering defender joins from behind to even the numbers, then the group plays on.",
        "Swap roles after each turn.",
      ],
      coachingPoints: [
        "Stay between the ball and the goal.",
        "Back up slowly, side-on, and do not commit.",
        "Show the attacker the way you want them to go.",
        "Time the tackle only when the numbers are equal or the ball is loose.",
      ],
      commonMistakes: [
        "Rushing in and getting beaten.",
        "Backing off too quickly.",
        "Standing square-on to the ball carrier.",
      ],
      progressions: {
        easier: [
          "Attackers pass slowly.",
          "Recovering defender starts closer.",
        ],
        harder: [
          "Recovering defender starts further away.",
          "Time limit for the attackers.",
        ],
      },
      safety: defendingSafety,
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["defending", "2v1", "delaying", "jockeying", "outnumbered"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact 2v1 format was located."),
      ],
      diagram: grid({
        players: [
          Goal(40, 4, 20),
          P(44, 50, "A", "1"),
          P(58, 50, "A", "2"),
          Ball(46, 48),
          P(50, 22, "B", "D"),
          P(50, 58, "B", "R"),
          Pass(46, 48, 58, 40, 1),
          Run(50, 26, 50, 22, 2),
          Run(50, 58, 50, 48, 3),
          Text(50, 13, "D delays; R recovers from behind"),
        ],
        caption:
          "Two attackers advance on one defender (D) who delays them until the recovering defender (R) arrives.",
      }),
    },
  }),
  drill({
    number: 43,
    categoryId: cat,
    name: "3-Team Transition Game (2v4 Intense Pressing)",
    originalObjective: "High-intensity group press.",
    focusArea: "Defending",
    purpose: "Builds team pressing and quick reactions in short, intense bouts.",
    cue: "Press together on the trigger, then recover.",
    summary:
      "Three teams rotate: a pressing pair works against a team of four in possession while the third team rests.",
    interpretation:
      "'2v4' is read as two pressers against four players in possession, with a third team resting. The three-team rotation builds recovery into the practice.",
    content: {
      description:
        "Three groups share one grid. A team of four keeps the ball while a pair from the second team presses them (2v4). The third team rests on the side. After a short bout the pressing pair rests, the resting team supplies the next pair and the possession team continues, so the intense work is shared and recovery is built in. Pressing starts on clear triggers rather than chasing the ball.",
      skills: ["Pressing as a pair", "Pressing triggers", "Transition", "Recovery"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 8, max: 15, note: "Teams of two to five; one team presses at a time" },
      equipment: [
        "Cones to mark the grid and a resting zone",
        "Balls",
        "Bibs of three colours",
        "A whistle and a timer for the coach",
      ],
      setup: {
        layout:
          "One playing grid with four possession players spread around it. The pressing pair starts inside. The third team waits in a marked resting zone beside the grid.",
        dimensions: DIM.grid,
      },
      steps: [
        "Team B (four players) keeps the ball in the grid; team A sends a pair of pressers in.",
        "The pressing pair presses only on a trigger: a back pass, a poor touch, a receiver facing their own goal, or a pass played to the side where the presser is.",
        "If the pressers win the ball, or on the coach's whistle at the end of the bout, the bout ends and the pressing pair leaves to the resting zone.",
        "The resting team sends the next pair in; the possession team keeps going (swap the possession team with another team every few bouts).",
        "Pressers recover at the side: walk or jog, drink and watch; they only re-enter on the coach's call.",
        "Keep bouts short and stop earlier if pressing quality or control drops.",
      ],
      coachingPoints: [
        "Press together: one presses the ball, the other cuts the passing lane.",
        "Press on the trigger, not on every pass.",
        "Close down quickly, then slow down and stay balanced as you arrive.",
        "On losing the ball or at the end of the bout, recover and rest honestly.",
      ],
      commonMistakes: [
        "Pressing from far away with no trigger.",
        "Both pressers chasing the same player.",
        "Returning into the grid before the call.",
      ],
      progressions: {
        easier: [
          "Make the grid bigger or let the possession team use more touches.",
          "Give the pressers a slightly shorter bout and longer rest.",
        ],
        harder: [
          "Reduce the possession team's touches.",
          "Require the pressers to win the ball within a short window.",
        ],
      },
      safety: [
        "Contact rules: no sliding tackles and no tackling from behind; challenges are fair and for the ball only, and no contact above the waist.",
        "High-intensity work is limited to short bouts. The three-team rotation provides recovery, with the resting team at least matching the working time; the coach ends a bout early if quality drops.",
        "Pressers recover at the side and may drink; any player who looks unwell or too tired stops at once.",
        "Keep the grid clear and the resting zone outside the playing area.",
      ],
      phase: "GAME",
      intensity: "HIGH",
      tags: ["pressing", "transition", "3-team", "2v4", "intense", "rotation"],
      references: [
        REF.fifa4v4plus2,
        limitation(
          "No source was located for this exact three-team 2v4 format. No work or rest durations are specified; the coach decides from the players' age and condition.",
        ),
      ],
      diagram: threeTeamRotation({
        caption:
          "Team B (four players) keeps the ball; a pressing pair (P) presses on triggers; team C rests and supplies the next pair.",
      }),
    },
  }),
  drill({
    number: 44,
    categoryId: cat,
    name: "Four-Goal Number-Down",
    originalObjective: "Defensive block organization.",
    focusArea: "Positioning",
    purpose: "Teaches a team to defend together when it has fewer players.",
    cue: "Stay compact and move as a unit.",
    summary:
      "Two teams play towards four goals; one team has one fewer player and must defend as a compact block.",
    interpretation:
      "Two teams, four goals (two for each team to defend). One team is a player short and organises as a compact block.",
    distinctFrom: [
      {
        number: 42,
        difference:
          "Drill 42 is one defender delaying two attackers. Drill 44 trains a whole team's block organisation in a larger game.",
      },
      {
        number: 32,
        difference:
          "Drill 32 has four teams. Drill 44 has two teams, four goals and an intentional numerical disadvantage.",
      },
    ],
    content: {
      description:
        "Two teams play in a grid with two goals at each end. One team has one fewer player, so it must defend in a compact block, shifting together and protecting both of its goals. The larger team learns to find space against the block. It trains block organisation and communication.",
      skills: ["Block organisation", "Compactness", "Communication", "Shifting"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 8, max: 18 },
      equipment: ["Four goals or sets of cones", "Balls", "Bibs", "Cones to mark the area"],
      setup: {
        layout:
          "A grid with two goals at each end. The team with an extra player attacks; the smaller team defends two goals.",
        dimensions: DIM.grid,
      },
      steps: [
        "The larger team tries to score in either of the two goals the smaller team defends.",
        "The smaller team stays compact, shifting side to side with the ball.",
        "Defenders talk to each other, calling who presses and who covers.",
        "If the defenders win the ball they try to score in the other end.",
        "Swap the roles and the numerical advantage regularly.",
      ],
      coachingPoints: [
        "Stay compact: keep the distances between defenders short.",
        "Shift together as the ball moves.",
        "Close the space between the lines.",
        "One presses; the others cover and balance.",
      ],
      commonMistakes: [
        "Defenders spread out and disconnected.",
        "Ball-watching and ignoring the far goal.",
        "No communication.",
      ],
      progressions: {
        easier: [
          "Equal numbers first.",
          "Smaller goals for the attacking team.",
        ],
        harder: [
          "Two players down.",
          "Restrict touches for the attacking team.",
        ],
      },
      safety: [...defendingSafety, SAFE.goal],
      phase: "GAME",
      intensity: "HIGH",
      tags: ["defending", "block", "four goals", "numbers down", "compactness"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact format was located."),
      ],
      diagram: layout(
        "four-goal-game",
        "GRID",
        [
          Zone(20, 8, 60, 48),
          Goal(14, 14, 3, 12),
          Goal(14, 38, 3, 12),
          Goal(83, 14, 3, 12),
          Goal(83, 38, 3, 12),
          P(30, 22, "B"),
          P(32, 34, "B"),
          P(30, 46, "B"),
          P(64, 14, "A"),
          P(68, 28, "A"),
          P(62, 40, "A"),
          P(70, 50, "A"),
          Ball(66, 30),
          Pass(66, 30, 62, 42, 1),
        ],
        "Team A (one extra player) attacks two goals defended by a compact block of team B.",
      ),
    },
  }),
  drill({
    number: 45,
    categoryId: cat,
    name: "Breaking the Block",
    originalObjective: "Dislodging a deep defensive line.",
    focusArea: "Positioning",
    purpose: "Practises both defending deep and finding ways through.",
    cue: "Stay compact, or move the ball to find the gap.",
    summary:
      "Attackers try to break down a deep defensive block, while the block practises staying compact and organised.",
    interpretation:
      "Kept under Defending & Pressing as approved. The practice trains both roles: the block holds its shape, and the attackers work to dislodge it.",
    content: {
      description:
        "A defending team sits in a deep, compact block near its goal. The attacking team tries to find ways through with passing, switches of play and runs. The block practises staying compact, communicating and reacting to the ball; the attackers practise patience and creating gaps.",
      skills: ["Defending in a block", "Patience in attack", "Switching play", "Communication"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 10, max: 20 },
      equipment: ["Goal", "Balls", "Cones", "Bibs"],
      setup: {
        layout:
          "A half pitch with a goal. The defending team forms a block near the goal; the attacking team starts with the ball further out.",
        dimensions: DIM.half,
      },
      steps: [
        "The attackers move the ball around the block, looking for a gap or an overload.",
        "The block shifts together, keeping close to each other and denying space between the lines.",
        "Attackers switch the ball quickly to the other side to pull the block apart.",
        "Attackers try to finish with a shot or a pass through the block.",
        "If the defenders win the ball they clear to a target or counter into a small goal.",
        "Swap roles after a set time.",
      ],
      coachingPoints: [
        "Defenders: stay compact and move together; talk constantly.",
        "Attackers: be patient and use quick switches.",
        "Look for the player in space between the lines.",
        "Do not force a pass through a crowd; move the ball and try again.",
      ],
      commonMistakes: [
        "Defenders spread out.",
        "Attackers forcing the ball into a crowded middle.",
        "Not switching play fast enough.",
      ],
      progressions: {
        easier: [
          "Fewer defenders.",
          "Unlimited touches for attackers.",
        ],
        harder: [
          "Fewer attackers, or limit touches.",
          "Add a time limit.",
        ],
      },
      safety: [...defendingSafety, SAFE.goal],
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["defending", "attacking", "block", "switching", "compactness"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact format was located."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          P(50, 6, "GK"),
          P(30, 16, "B"),
          P(42, 16, "B"),
          P(58, 16, "B"),
          P(70, 16, "B"),
          P(36, 24, "B"),
          P(64, 24, "B"),
          P(22, 46, "A"),
          P(50, 48, "A"),
          P(78, 46, "A"),
          P(36, 36, "A"),
          P(64, 36, "A"),
          Ball(52, 46),
          Pass(52, 46, 76, 46, 1),
          Pass(76, 44, 66, 38, 2),
          Run(36, 36, 44, 26, 3),
          C(30, 8),
          C(70, 8),
        ],
        "A compact deep block (B) defends the goal while the attackers (A) switch play to find a gap.",
      ),
    },
  }),
];
