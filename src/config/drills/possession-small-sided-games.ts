import type { UniversalDrill } from "@/domain/drill-library";
import {
  Ball,
  C,
  P,
  Pass,
  Run,
  Text,
  Zone,
  fourGoalGame,
  grid,
  rondo,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "possession-small-sided-games" as const;

const gameSafety = [
  SAFE.contact,
  "Keep spare balls outside the area and stop play at once if a ball enters the pitch from outside.",
  SAFE.water,
];

export const possessionSmallSidedGames: UniversalDrill[] = [
  drill({
    number: 25,
    categoryId: cat,
    name: "4v2 Rondos",
    originalObjective: "Transition and quick passing in tight spaces.",
    focusArea: "Passing",
    purpose: "Builds quick passing and reactions when the ball changes hands.",
    cue: "Pass quickly and move to help.",
    summary:
      "Four players keep the ball from two defenders in a small square; whoever loses it swaps in.",
    distinctFrom: [
      {
        number: 26,
        difference:
          "Drill 25 is four outside players against two inside defenders with the emphasis on transition. Drill 26 is a positional three-against-one with one neutral support player.",
      },
      {
        number: 27,
        difference:
          "Drill 27 is a larger circle with rotating roles and decision-making. Drill 25 is a small square with four outside players.",
      },
    ],
    content: {
      description:
        "Four players stand around the outside of a small square and pass the ball. Two defenders inside try to win it. When a defender wins the ball or it goes out, the defender swaps with the player who made the mistake. It trains quick, accurate passing in tight space and a quick reaction at the moment the ball changes hands.",
      skills: ["Quick passing", "Transition", "Support angles", "Pressing"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 6, max: 18, note: "Groups of six" },
      equipment: ["Four cones per square", "One ball per square", "Bibs for defenders"],
      setup: {
        layout:
          "A small square marked with cones. Four attackers stand around it and two defenders stand inside.",
        dimensions: DIM.grid,
      },
      steps: [
        "The four outside players pass the ball to each other around the square.",
        "The two defenders work together to press the ball and cut passing lanes.",
        "If a defender wins the ball, or a pass goes out of the square, the player who lost it swaps with that defender.",
        "Outside players keep moving to give clear angles for the pass.",
        "Change defenders every few turns, and give the group a fresh square to challenge.",
      ],
      coachingPoints: [
        "Pass quickly and accurately with the inside of the foot.",
        "Move to create an angle after every pass.",
        "Defenders press together and cut passing lanes.",
        "React at once when possession changes.",
      ],
      commonMistakes: [
        "Standing still after passing.",
        "Passing too hard or too soft.",
        "Defenders pressing separately.",
      ],
      progressions: {
        easier: [
          "Use a larger square or give the outside players two touches.",
          "A single defender at first.",
        ],
        harder: [
          "One touch for the outside players.",
          "Smaller square or a neutral player inside.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["rondo", "4v2", "possession", "transition", "tight space"],
      references: [
        REF.fifaDynamicRondos,
        REF.uefaGrassroots,
        limitation("The FIFA page was located by search but could not be opened, so details here are original and unverified against it."),
      ],
      diagram: rondo({
        outer: 4,
        inner: 2,
        caption:
          "Four outside players (A) keep the ball from two defenders (B) in a small square.",
      }),
    },
  }),
  drill({
    number: 26,
    categoryId: cat,
    name: "3v1 + 1 Rondo",
    originalObjective: "Positional support and recycling possession.",
    focusArea: "Positioning",
    purpose: "Practises supporting the ball and keeping possession.",
    cue: "Give an angle and keep the ball moving.",
    summary:
      "Three attackers and one neutral supporting player keep the ball from one defender in a small area.",
    interpretation:
      "The '+1' is one neutral supporting player who always plays with the team in possession. The neutral is shown as 'N' in the diagram.",
    distinctFrom: [
      {
        number: 25,
        difference:
          "Drill 25 uses four outside players against two defenders. Drill 26 is a positional 3v1 with a single neutral support player to recycle possession.",
      },
      {
        number: 30,
        difference:
          "Drill 30 uses floaters on a bigger grid with teams. Drill 26 is a small rondo with one defender and one neutral.",
      },
    ],
    content: {
      description:
        "Three players in possession plus one neutral supporting player keep the ball from one defender. The neutral player always plays for the team with the ball, so possession is a four-against-one in effect, but the three attackers and the neutral have set roles. It trains positional support and recycling of possession.",
      skills: ["Positional play", "Support angles", "Recycling possession", "Awareness"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 5, max: 15, note: "Groups of five" },
      equipment: ["Cones", "One ball per area", "Bibs of three colours"],
      setup: {
        layout:
          "A small area with three attackers on its edges, one defender inside and one neutral supporting player inside the area.",
        dimensions: DIM.grid,
      },
      steps: [
        "The three attackers pass the ball to each other and to the neutral player.",
        "The neutral player always plays for the team in possession and may be used to recycle the ball.",
        "The defender tries to win the ball or force a mistake.",
        "If the defender wins the ball or it goes out, the player who lost it becomes the defender.",
        "Rotate the neutral role regularly.",
      ],
      coachingPoints: [
        "Open angles so the passer always has an option.",
        "The neutral player moves into free spaces to receive.",
        "Use the neutral to recycle possession when blocked.",
        "Communicate with calls such as 'turn' or 'back'.",
      ],
      commonMistakes: [
        "Attackers bunched together.",
        "Neutral player standing still.",
        "Ignoring the neutral player.",
      ],
      progressions: {
        easier: [
          "Bigger area or two touches.",
          "Give attackers extra time before the defender starts.",
        ],
        harder: [
          "One touch.",
          "Smaller area, or limit the neutral to two touches.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["rondo", "3v1", "neutral player", "support", "possession"],
      references: [
        REF.fifa3v1,
        REF.uefaGrassroots,
        limitation("The FIFA page was located by search but could not be opened, so details here are original and unverified against it."),
      ],
      diagram: rondo({
        outer: 3,
        inner: 1,
        neutral: 1,
        caption:
          "Three attackers (A) and one neutral supporter (N) keep the ball from one defender (B).",
      }),
    },
  }),
  drill({
    number: 27,
    categoryId: cat,
    name: "Circle Possession",
    originalObjective: "Decision-making and responsibility.",
    focusArea: "Positioning",
    purpose: "Builds decision-making and sharing responsibility in a group.",
    cue: "Look up, choose the pass and own your role.",
    summary:
      "A larger circle of players keeps possession from two rotating defenders, with clear individual responsibilities.",
    interpretation:
      "'Responsibility' is read as each player's job within the circle: offering a clear angle, choosing the pass and stepping in as defender when it is their turn.",
    distinctFrom: [
      {
        number: 25,
        difference:
          "Drill 25 is a small square with four players outside. Drill 27 is a larger circle with more players and rotating defenders, to emphasise decisions and individual responsibility.",
      },
    ],
    content: {
      description:
        "A group stands in a circle with two defenders in the middle. The players on the circle pass the ball across and around while the defenders try to win it. Players take turns as defenders. The practice builds quick decisions, an understanding of angles and every player's responsibility to offer and use passing lanes.",
      skills: ["Decision-making", "Passing lanes", "Responsibility", "Awareness"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 8, max: 16 },
      equipment: ["Cones to mark a circle", "One or two balls", "Bibs for defenders"],
      setup: {
        layout:
          "A circle of cones with players spread around it and two defenders inside.",
        dimensions: DIM.grid,
      },
      steps: [
        "The outside players pass around and across the circle, looking for open lanes.",
        "The two defenders inside try to intercept or force a bad pass.",
        "When a defender wins the ball, or a pass goes out of the circle, the player responsible swaps with that defender.",
        "Each player must offer an angle every time the ball is on their side.",
        "Add a second ball when the group is confident.",
      ],
      coachingPoints: [
        "Check the lanes before you pass, not after.",
        "Always give the passer a clear angle.",
        "Be honest about your own mistakes and accept the swap.",
        "Talk to each other throughout.",
      ],
      commonMistakes: [
        "Passing without checking lanes.",
        "Players waiting rather than moving.",
        "Defenders chasing instead of cutting lanes.",
      ],
      progressions: {
        easier: [
          "Fewer defenders or unlimited touches.",
          "A larger circle.",
        ],
        harder: [
          "Limit touches or add a second ball.",
          "Smaller circle.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["rondo", "possession", "circle", "decision-making", "responsibility"],
      references: [
        REF.fifaDynamicRondos,
        limitation("The FIFA page was located by search but could not be opened; this circle format is Sportozen's own."),
      ],
      diagram: rondo({
        outer: 8,
        inner: 2,
        shape: "circle",
        caption:
          "Eight players on a circle pass across it while two defenders inside try to win the ball.",
      }),
    },
  }),
  drill({
    number: 28,
    categoryId: cat,
    name: "Grid Keepaway",
    originalObjective: "Spreading out to maintain team shape.",
    focusArea: "Positioning",
    purpose: "Teaches spreading out to keep the ball as a team.",
    cue: "Spread out and give clear passing options.",
    summary:
      "A team keeps the ball from a smaller team in a grid, spreading wide to keep shape.",
    distinctFrom: [
      {
        number: 29,
        difference:
          "Drill 28 is a single grid focused on team shape. Drill 29 splits the grid into two sections and rewards penetration to a target.",
      },
      {
        number: 30,
        difference:
          "Drill 30 adds neutral floaters; Drill 28 has no neutral players.",
      },
    ],
    content: {
      description:
        "A team with more players keeps possession from a smaller defending team inside a single grid. The possession team spreads out to use the whole grid so that passing lanes stay open. Teams change roles when possession is lost.",
      skills: ["Team shape", "Spreading out", "Passing", "Positioning"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 12,
      players: { min: 8, max: 18 },
      equipment: ["Cones", "Balls", "Bibs for two teams"],
      setup: {
        layout:
          "One grid. The larger team passes around the edges and inside; the smaller team defends.",
        dimensions: DIM.grid,
      },
      steps: [
        "The possession team passes the ball, trying to keep it for as long as possible.",
        "The defending team presses and tries to win it.",
        "If the defenders win the ball, the team that lost it swaps roles.",
        "Count consecutive passes to give a target.",
        "Rotate who defends so everyone has a turn.",
      ],
      coachingPoints: [
        "Use the whole grid: stay wide, long and deep.",
        "Move to open a passing lane after you pass.",
        "Pass to the player with the most space.",
        "Defenders press as a team.",
      ],
      commonMistakes: [
        "Players bunching together.",
        "Only passing to the nearest player.",
        "Defenders chasing the ball alone.",
      ],
      progressions: {
        easier: [
          "Larger grid or more attackers.",
          "No touch limit.",
        ],
        harder: [
          "Two touches maximum.",
          "Smaller grid.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["possession", "keepaway", "team shape", "grid"],
      references: [
        REF.fifa4v4plus2,
        REF.uefaGrassroots,
        limitation("The FIFA page was located by search but could not be opened."),
      ],
      diagram: grid({
        players: [
          P(24, 12, "A"),
          P(76, 12, "A"),
          P(24, 50, "A"),
          P(76, 50, "A"),
          P(50, 8, "A"),
          P(50, 54, "A"),
          P(44, 30, "B"),
          P(58, 34, "B"),
          P(50, 24, "B"),
          Ball(27, 14),
          Pass(27, 14, 47, 10, 1),
          Pass(52, 10, 74, 14, 2),
          Pass(76, 16, 76, 46, 3),
        ],
        caption:
          "The possession team (A) spreads around the grid while the defenders (B) press the ball.",
      }),
    },
  }),
  drill({
    number: 29,
    categoryId: cat,
    name: "Two-Section Keepaway",
    originalObjective: "Penetration and target play.",
    focusArea: "Passing",
    purpose: "Practises passing through a line to a teammate ahead.",
    cue: "Find the gap and play forward.",
    summary:
      "A grid split in two sections: the team must pass through to a target player in the far section to score a point.",
    distinctFrom: [
      {
        number: 28,
        difference:
          "Drill 28 is one grid about team shape. Drill 29 splits the grid and rewards a pass through to a target, so it trains penetration.",
      },
    ],
    content: {
      description:
        "The grid is split into two sections. The possession team starts in one section with a target player waiting in the other. To score a point, the team must pass the ball to the target player, who then returns it so the sequence starts again. Defenders try to stop passes through the dividing line. It trains looking for penetrating passes and target play.",
      skills: ["Penetrating passes", "Target play", "Patience", "Support"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 8, max: 18 },
      equipment: ["Cones", "Balls", "Bibs for three roles"],
      setup: {
        layout:
          "A grid divided into two sections by a line of cones. The possession team starts in the first section with defenders; a target player stands in the second.",
        dimensions: DIM.grid,
      },
      steps: [
        "The possession team passes in the first section, looking for a gap to the target.",
        "Defenders try to stop passes going through the line.",
        "A pass to the target player scores a point; the target returns it and the team restarts.",
        "If defenders win the ball, the team that lost it swaps roles.",
        "Rotate the target player.",
      ],
      coachingPoints: [
        "Be patient: move the ball side to side to open a lane.",
        "Pass firmly into the target's feet.",
        "The target player shows for the ball and controls it.",
        "Support the target on the return.",
      ],
      commonMistakes: [
        "Forcing the pass too early.",
        "Defenders staying only near the ball.",
        "Target player not moving to be available.",
      ],
      progressions: {
        easier: [
          "No defenders in the first section.",
          "A bigger target zone.",
        ],
        harder: [
          "Limit touches in the first section.",
          "Add a defender near the target.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["possession", "penetration", "target player", "two sections"],
      references: [
        REF.fifa4v4plus2,
        limitation("The FIFA page was located by search but could not be opened; the two-section layout here is Sportozen's own."),
      ],
      diagram: grid({
        players: [
          Zone(18, 6, 32, 52, "Section 1"),
          Zone(50, 6, 32, 52, "Section 2"),
          P(26, 14, "A"),
          P(44, 46, "A"),
          P(30, 38, "A"),
          P(38, 26, "B"),
          P(34, 44, "B"),
          P(72, 28, "N", "T"),
          Ball(28, 16),
          Pass(28, 16, 42, 44, 1),
          Pass(44, 44, 70, 30, 2),
        ],
        caption:
          "The possession team works in Section 1 and passes through the line to the target (T) in Section 2.",
        extra: [C(50, 6), C(50, 58)],
      }),
    },
  }),
  drill({
    number: 30,
    categoryId: cat,
    name: "Floater Grid Possession",
    originalObjective: "Neutral players providing numerical advantage.",
    focusArea: "Positioning",
    purpose: "Shows how a spare player helps a team keep the ball.",
    cue: "Use the free player to keep the ball moving.",
    summary:
      "Two teams contest a grid, with neutral floaters who always play for the team in possession.",
    distinctFrom: [
      {
        number: 26,
        difference:
          "Drill 26 is a small rondo with one defender and a single neutral. Drill 30 has two full teams and floaters in a bigger grid.",
      },
      {
        number: 28,
        difference: "Drill 28 has no neutral players at all.",
      },
    ],
    content: {
      description:
        "Two teams play in a grid with one or two neutral players, the floaters, who always play for the team in possession. The floaters give the team with the ball a numerical advantage. Teams learn to use the extra player to keep and move the ball.",
      skills: ["Using an overload", "Passing", "Movement", "Decision-making"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 14,
      players: { min: 8, max: 20 },
      equipment: ["Cones", "Balls", "Bibs of three colours"],
      setup: {
        layout:
          "One grid. Two teams of equal size and two floaters in a third bib colour.",
        dimensions: DIM.grid,
      },
      steps: [
        "Two teams play inside the grid; the floaters always play for the team in possession.",
        "The team in possession plays with the extra players to keep the ball.",
        "When a team loses the ball, the floaters switch to support the other team.",
        "Count consecutive passes or play to goals.",
        "Rotate floaters so everyone has a turn.",
      ],
      coachingPoints: [
        "Use the floaters to open passing lanes.",
        "Floaters move so they are always an option.",
        "Defenders remain compact even when outnumbered.",
        "Switch the point of attack quickly.",
      ],
      commonMistakes: [
        "Ignoring the floaters.",
        "Floaters standing still.",
        "Defenders chasing instead of staying compact.",
      ],
      progressions: {
        easier: [
          "Bigger grid.",
          "Two floaters instead of one.",
        ],
        harder: [
          "One floater only.",
          "Two touches maximum.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "MEDIUM",
      tags: ["possession", "floaters", "neutral players", "overload"],
      references: [
        REF.fifa4v4plus2,
        REF.uefaGrassroots,
        limitation("The FIFA page was located by search but could not be opened."),
      ],
      diagram: grid({
        players: [
          P(26, 16, "A"),
          P(50, 24, "A"),
          P(70, 16, "A"),
          P(30, 46, "B"),
          P(52, 40, "B"),
          P(72, 46, "B"),
          P(20, 32, "N", "F"),
          P(80, 32, "N", "F"),
          Ball(28, 18),
          Pass(28, 18, 20, 30, 1),
          Pass(22, 30, 48, 26, 2),
        ],
        caption:
          "Two teams (A and B) in a grid with two neutral floaters (F) who always play for the team with the ball.",
      }),
    },
  }),
  drill({
    number: 31,
    categoryId: cat,
    name: "2v2 + 2 Small-Sided Possession",
    originalObjective: "Dynamic transition play.",
    focusArea: "Positioning",
    purpose: "Builds quick reactions when possession changes in a small game.",
    cue: "React the moment the ball changes hands.",
    summary:
      "Two pairs contest the ball in a small area with two neutral supporting players on the outside.",
    interpretation:
      "The '+2' is two neutral supporting players who always play with the team in possession. They are shown as 'N' in the diagram.",
    distinctFrom: [
      {
        number: 25,
        difference:
          "Drill 25 is four outside players against two defenders. Drill 31 is a 2v2 game with two neutrals who help whoever has the ball.",
      },
    ],
    content: {
      description:
        "Two teams of two play in a small area. Two neutral players stand on the outside and always play for the team in possession. The teams switch between attacking and defending instantly whenever the ball is won or lost. It trains quick reactions at the moment of transition.",
      skills: ["Transition", "Quick passing", "Reactions", "Pressing"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 6, max: 18, note: "Groups of six" },
      equipment: ["Cones", "One ball per area", "Bibs of three colours"],
      setup: {
        layout:
          "A small area with two pairs inside it and one neutral on each side of the area.",
        dimensions: DIM.grid,
      },
      steps: [
        "The pair with the ball plays with the neutrals to keep possession.",
        "The other pair tries to win the ball.",
        "When the ball is won, the winning pair becomes the possession team at once, and the other pair becomes the defenders.",
        "Neutral players join whoever has the ball.",
        "Rotate the neutrals and the pairs.",
      ],
      coachingPoints: [
        "Switch your mind from defending to attacking the second you win the ball.",
        "Use the neutrals to keep possession.",
        "Defenders: press quickly after losing the ball.",
        "Communicate constantly.",
      ],
      commonMistakes: [
        "Pausing after winning or losing the ball.",
        "Ignoring the neutrals.",
        "Both defenders chasing the ball.",
      ],
      progressions: {
        easier: [
          "Larger area.",
          "Allow unlimited touches.",
        ],
        harder: [
          "Smaller area.",
          "Two touches for the neutrals.",
        ],
      },
      safety: gameSafety,
      phase: "GAME",
      intensity: "HIGH",
      tags: ["possession", "2v2", "neutral players", "transition"],
      references: [
        REF.fifa4v4plus2,
        limitation("The FIFA page was located by search but could not be opened."),
      ],
      diagram: grid({
        players: [
          P(46, 22, "A"),
          P(62, 40, "A"),
          P(40, 44, "B"),
          P(60, 22, "B"),
          P(18, 32, "N", "N"),
          P(82, 32, "N", "N"),
          Ball(48, 24),
          Pass(46, 24, 21, 30, 1),
          Pass(22, 34, 59, 39, 2),
          Run(40, 42, 46, 32, 3),
        ],
        caption:
          "Two pairs (A and B) contest a small area; two neutral players (N) always play with the team in possession.",
      }),
    },
  }),
  drill({
    number: 32,
    categoryId: cat,
    name: "Four-Team Four-Goal Game",
    originalObjective: "Switching play and defensive balance.",
    focusArea: "Positioning",
    purpose: "Builds switching play and balanced defending in a small game.",
    cue: "Switch the ball quickly and stay balanced.",
    summary:
      "Four teams, four goals: each team defends one goal while attacking another, switching play and keeping balance.",
    interpretation:
      "Four teams of equal size, each defending its own goal, with the ball played at any other team's goal.",
    content: {
      description:
        "Four small teams play in a square with a goal on each side. Each team defends its own goal and can score in any of the others. With three opposing teams and three goals to attack, players must switch the ball quickly and keep defensive balance. It trains scanning for the goal that is least protected.",
      skills: ["Switching play", "Defensive balance", "Scanning", "Decision-making"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 8, max: 20, note: "Four teams of two to five" },
      equipment: ["Four goals or sets of cones", "Balls", "Bibs of four colours"],
      setup: {
        layout:
          "A square with a goal in the middle of each side. Each team stands near its own goal.",
        dimensions: DIM.grid,
      },
      steps: [
        "Any team starts with the ball and attacks one of the other three goals.",
        "Each team defends its own goal and tries to win the ball.",
        "A goal scored against a team counts as a point for the scorer; play restarts with the team that conceded.",
        "Play at a steady pace and rotate the starting team.",
        "Pause to ask which goal is open and how to switch to it.",
      ],
      coachingPoints: [
        "Look for the goal with the fewest defenders.",
        "Switch the ball quickly to unbalance defenders.",
        "Defenders stay between the ball and their own goal.",
        "Talk to your team about covering the goal.",
      ],
      commonMistakes: [
        "Attacking the same goal each time.",
        "Defenders ball-watching.",
        "Leaving the goal unguarded when attacking.",
      ],
      progressions: {
        easier: [
          "Larger square or fewer teams.",
          "Bigger goals.",
        ],
        harder: [
          "Limit touches.",
          "Smaller goals or a time limit to score.",
        ],
      },
      safety: [...gameSafety, SAFE.goal],
      phase: "GAME",
      intensity: "HIGH",
      tags: ["small-sided", "four goals", "switching", "defensive balance"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact four-team format was located."),
      ],
      diagram: fourGoalGame({
        caption:
          "Four teams (A, B, C and D) each defend their own goal and attack any of the other three.",
      }),
    },
  }),
  drill({
    number: 33,
    categoryId: cat,
    name: "Numbers Game",
    originalObjective: "Transition chaos with numerical imbalances.",
    focusArea: "Recovery movement",
    purpose: "Practises quick thinking when team numbers keep changing.",
    cue: "Count the numbers quickly and react.",
    summary:
      "A small-sided game where the coach calls numbers so players join or leave play, creating changing overloads.",
    interpretation:
      "'Transition chaos' is controlled: the coach calls numbers at set moments so extra players join or leave, and the group has to recognise and use the overload quickly.",
    content: {
      description:
        "Two teams play a small-sided game. Players are numbered. The coach calls numbers and those players join or leave the game, which creates temporary overloads and underloads. Players need to count quickly, recognise whether they are outnumbered or have an advantage, and react. It trains decision-making in changing situations.",
      skills: ["Transition", "Counting numbers", "Decision-making", "Recovery runs"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "ADVANCED",
      durationMinutes: 14,
      players: { min: 8, max: 20 },
      equipment: ["Cones", "Balls", "Goals", "Bibs"],
      setup: {
        layout:
          "A small pitch with goals. Two teams play inside; extra players wait at the sides, each with a number.",
        dimensions: DIM.half,
      },
      steps: [
        "Two even teams play a small-sided game.",
        "The coach calls a number; that player (from the side or from a team) joins or leaves play.",
        "The attacking team uses its advantage quickly, while the outnumbered team defends sensibly.",
        "Call several numbers over time to change the balance.",
        "Rotate players on the side with those in play.",
      ],
      coachingPoints: [
        "Count the numbers as soon as the call is made.",
        "The team with the advantage plays quickly and moves the ball.",
        "The outnumbered team delays and stays compact.",
        "Recover quickly after the call.",
      ],
      commonMistakes: [
        "Not noticing the call.",
        "Slow joining or leaving.",
        "Forcing play when outnumbered.",
      ],
      progressions: {
        easier: [
          "Call one number at a time.",
          "Longer pauses between calls.",
        ],
        harder: [
          "Call two numbers at once.",
          "Quick successive calls.",
        ],
      },
      safety: [
        "Players join and leave at the edge and wait for the ball to be clear before entering.",
        ...gameSafety,
      ],
      phase: "GAME",
      intensity: "HIGH",
      tags: ["small-sided", "transition", "overload", "numbers", "decision-making"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact variant was located."),
      ],
      diagram: grid({
        players: [
          P(30, 18, "A"),
          P(48, 30, "A"),
          P(62, 18, "A"),
          P(72, 40, "A"),
          P(36, 42, "B"),
          P(54, 46, "B"),
          P(66, 30, "B"),
          P(12, 52, "A", "5"),
          Ball(32, 20),
          Pass(32, 20, 60, 20, 1),
          Run(14, 50, 30, 38, 2),
          Text(30, 62, "Called number joins"),
        ],
        caption:
          "A 4v3 game after a number is called: player 5 comes on from the side to create a temporary overload.",
        area: { x: 20, y: 6, w: 70, h: 52 },
      }),
    },
  }),
];
