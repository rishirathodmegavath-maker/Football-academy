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
  grid,
  layout,
  slalom,
  wallLane,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "ball-control-dribbling" as const;

export const ballControlDribbling: UniversalDrill[] = [
  drill({
    number: 8,
    categoryId: cat,
    name: "Wall-Kicks / Wall Passing",
    originalObjective: "First touch and passing accuracy off a rebound.",
    focusArea: "First touch and receiving",
    purpose: "Builds first touch and passing accuracy using a rebound surface.",
    cue: "Pass through the middle of the ball, then cushion the return.",
    summary:
      "Individual technical practice against a wall or rebound board: pass, control the return, pass again.",
    interpretation:
      "'Wall-Kicks' and 'Wall Passing' are two names for the same drill: passing against a rebound surface. It is an individual technical drill, not a partner drill.",
    distinctFrom: [
      {
        number: 22,
        difference:
          "Drill 8 uses a passive rebound surface and the player stays largely in place to train touch and accuracy. Drill 22 uses a teammate as the 'wall' and trains movement and timing after the pass.",
      },
      {
        number: 16,
        difference:
          "Drill 16 is a three-player shape and support practice; Drill 8 is one player against a surface.",
      },
    ],
    content: {
      description:
        "One player works alone against a wall or rebound board. They pass the ball against the surface and control the return with a clean first touch, then pass again. The surface is passive: it returns the ball without moving, so the player can focus on technique, weight of pass and a soft first touch with either foot.",
      skills: ["First touch", "Passing accuracy", "Weight of pass", "Both feet"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 10,
      players: { min: 1, max: 12, note: "One player per wall section or rebound board" },
      equipment: [
        "A smooth wall or rebound board (required for this drill)",
        "One ball per player",
        "Cones to mark each player's lane",
      ],
      setup: {
        layout:
          "Each player has a marked lane facing the wall or rebound board, with a clear buffer between lanes and nothing in the ball's path.",
        dimensions: DIM.lane,
      },
      steps: [
        "Stand facing the wall in your own lane with a ball at your feet.",
        "Pass the ball against the wall using the inside of the foot.",
        "Control the return with a soft first touch to set the ball for the next pass.",
        "Pass again; keep a steady rhythm and focus on contact and accuracy.",
        "Change feet, then change the part of the foot used (inside, outside, laces) when the coach calls.",
      ],
      coachingPoints: [
        "Strike through the middle of the ball with a firm ankle.",
        "Cushion the return by relaxing the receiving foot as the ball arrives.",
        "Take the first touch into a good position for the next pass.",
        "Use both feet equally.",
      ],
      commonMistakes: [
        "Passing too hard so the return is uncontrollable.",
        "Stiff first touch that bounces off the foot.",
        "Using only the stronger foot.",
      ],
      progressions: {
        easier: [
          "Stand closer and pass gently.",
          "Allow a second touch to control before passing.",
        ],
        harder: [
          "Pass with the first touch, without controlling first.",
          "Alternate feet on every pass.",
        ],
      },
      safety: [
        "The wall must be smooth and safe, with no glass, sharp edges or hazards behind the ball.",
        "Keep lanes clear so rebounds do not hit another player; stop if a ball strays.",
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "LOW",
      tags: ["first touch", "passing", "wall", "individual", "rebound"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact rebound-wall routine was located; no repetition counts are given."),
      ],
      diagram: wallLane({
        caption:
          "One player in a marked lane passes against a rebound surface and controls the return.",
      }),
    },
  }),
  drill({
    number: 9,
    categoryId: cat,
    name: "Stair Steppers on the Ball",
    originalObjective: "Rhythm and foot-speed control.",
    focusArea: "Dribbling",
    purpose: "Builds quick feet and rhythm on the ball.",
    cue: "Quick, light touches and stay balanced.",
    summary:
      "Alternating quick touches on top of the ball, like stepping up stairs, to train foot speed and rhythm.",
    interpretation:
      "'Stair stepper' is read as alternating light sole touches on top of the ball in a quick, stepping rhythm.",
    content: {
      description:
        "Each player stands over their ball and alternates light touches on the top of it with the sole of each foot, like stepping up a staircase. When comfortable, they add a short move forward or back between sequences. It trains foot speed, rhythm and balance.",
      skills: ["Foot speed", "Rhythm", "Balance", "Ball mastery"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 8,
      players: { min: 1, max: 24 },
      equipment: ["One ball per player"],
      setup: {
        layout: "Players spread out in their own space, each with a ball.",
        dimensions: DIM.grid,
      },
      steps: [
        "Stand with the ball in front, weight on the standing foot.",
        "Alternate light sole touches on top of the ball, left then right, at a comfortable speed.",
        "Keep the ball still and under the soles, not rolling.",
        "Speed up gradually as control improves, then slow down again.",
        "Add a small step back with the ball between sequences, then repeat.",
      ],
      coachingPoints: [
        "Light, quick touches rather than heavy ones.",
        "Stay on the toes with slightly bent knees.",
        "Keep your head up between touches.",
        "Keep a steady rhythm.",
      ],
      commonMistakes: [
        "Pressing down so the ball rolls away.",
        "Standing flat-footed.",
        "Looking down the whole time.",
      ],
      progressions: {
        easier: [
          "Slow down and use one foot at a time.",
          "Hold on to a partner or cone for balance.",
        ],
        harder: [
          "Move forwards while stepping.",
          "Add a change of direction after each sequence.",
        ],
      },
      safety: [
        "Players stay in their own space; keep clear of others.",
        "Rest between sequences if tired or off balance.",
        SAFE.surface,
      ],
      phase: "WARM_UP",
      intensity: "LOW",
      tags: ["ball mastery", "foot speed", "rhythm", "individual"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact variant was located."),
      ],
      diagram: grid({
        players: [
          P(30, 24, "A"),
          Ball(33, 27),
          P(62, 24, "A"),
          Ball(65, 27),
          Drib(33, 32, 33, 44, 1),
          Drib(65, 32, 65, 44, 2),
        ],
        caption:
          "Each player alternates light sole touches on top of the ball in their own space, then steps back with it.",
      }),
    },
  }),
  drill({
    number: 10,
    categoryId: cat,
    name: "Coned Dribbling Slalom",
    originalObjective:
      "Tight turns using inside and outside of both feet.",
    focusArea: "Dribbling",
    purpose: "Builds close control and turning with both feet.",
    cue: "Small touches and turn tightly.",
    summary:
      "Players dribble in and out of a line of cones with tight turns using both feet and different parts of the foot.",
    content: {
      description:
        "Players dribble through a line of cones, weaving left and right and turning tightly around each cone. They use the inside and outside of both feet. The practice builds close control, balance and changes of direction.",
      skills: ["Close control", "Turning", "Both feet", "Change of direction"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 10,
      players: { min: 2, max: 16 },
      equipment: ["Cones for each slalom line", "One ball per player"],
      setup: {
        layout:
          "Several parallel lines of cones with players queuing at the start of each line and a clear run-off at the end.",
        dimensions: DIM.lane,
      },
      steps: [
        "The first player dribbles to the first cone with small touches.",
        "Weave through the cones, turning tightly around each one and keeping the ball close.",
        "Use the inside and outside of both feet; the coach may call which one.",
        "At the end, dribble back along the outside to the line and tag the next player.",
        "Repeat, changing the parts of the foot used.",
      ],
      coachingPoints: [
        "Small, frequent touches near the cone.",
        "Use the foot furthest from the cone to shield the ball.",
        "Lower your centre of gravity into the turn.",
        "Look up between cones.",
      ],
      commonMistakes: [
        "Touching the ball too far ahead.",
        "Sweeping wide round each cone.",
        "Using only one foot.",
      ],
      progressions: {
        easier: [
          "Place the cones further apart.",
          "Walk the slalom with the ball first.",
        ],
        harder: [
          "Bring cones closer together.",
          "Add a finish with a pass or a shot.",
        ],
      },
      safety: [
        "Only one player dribbles in a line at a time and the next waits behind.",
        SAFE.surface,
        SAFE.balls,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["dribbling", "slalom", "turning", "both feet", "cones"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact slalom was located; cone spacing is left to the coach."),
      ],
      diagram: slalom({
        cones: 6,
        caption:
          "A line of cones with a player dribbling in and out, turning tightly, from the start to the finish.",
      }),
    },
  }),
  drill({
    number: 11,
    categoryId: cat,
    name: "1v1 Attacking in Wide Areas",
    originalObjective: "Beating a defender down the flank.",
    focusArea: "Dribbling",
    purpose: "Practises beating an opponent with the ball on the wing.",
    cue: "Attack at pace and commit the defender.",
    summary:
      "Wide 1v1 duels where an attacker tries to beat a defender down the flank and cross or shoot.",
    content: {
      description:
        "The attacker starts on the wing with the ball and faces one defender. The attacker tries to beat the defender down the flank and deliver a cross or shot. It trains confident one-to-one attacking, change of pace and decision-making in wide areas.",
      skills: ["1v1 attacking", "Change of pace", "Feints", "Decision-making"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 12,
      players: { min: 4, max: 14 },
      equipment: ["One goal or two cones as a goal", "Balls", "Bibs", "Cones to mark the lane"],
      setup: {
        layout:
          "A wide channel along one side of the pitch with a goal at the end. Attackers queue on the wing; defenders queue near the goal side.",
        dimensions: DIM.half,
      },
      steps: [
        "The attacker starts with the ball on the wing and the defender faces them.",
        "On the coach's signal the attacker dribbles forward and tries to beat the defender.",
        "Once past, the attacker crosses or shoots at the goal.",
        "The defender tries to delay, jockey and win the ball, then plays it to a target or out.",
        "Players swap roles and sides after each turn.",
      ],
      coachingPoints: [
        "Attack at speed at the defender, then use a clear change of direction.",
        "Disguise intentions with a feint or a shoulder drop.",
        "Accelerate away after beating the opponent.",
        "Defenders stay low, side-on and patient.",
      ],
      commonMistakes: [
        "Slowing down in front of the defender.",
        "Dribbling too close to the touchline with no options.",
        "Defender diving in too early.",
      ],
      progressions: {
        easier: [
          "Start the defender passive or slightly off the line.",
          "Give the attacker a bigger area.",
        ],
        harder: [
          "Add a second attacker for a 2v1 at the end.",
          "Add a recovering defender from behind.",
        ],
      },
      safety: [
        SAFE.contact,
        SAFE.goal,
        "Check that the touchline run-off is clear.",
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["1v1", "attacking", "wing", "dribbling", "crossing"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact wide 1v1 format was located."),
      ],
      diagram: layout(
        "grid",
        "HALF_PITCH",
        [
          Goal(38, 2, 24),
          Zone(66, 8, 28, 52, "Wide channel"),
          C(66, 8),
          C(94, 8),
          C(66, 60),
          C(94, 60),
          P(84, 52, "A"),
          Ball(86, 52),
          P(80, 34, "B"),
          Drib(84, 50, 86, 20, 1),
          Pass(84, 16, 58, 10, 2),
          Run(80, 36, 84, 28, 3),
          Mark(84, 58, "Start"),
        ],
        "An attacker starts wide with the ball, tries to beat the defender down the flank, then crosses or shoots.",
      ),
    },
  }),
  drill({
    number: 12,
    categoryId: cat,
    name: "Dribbling Square / Grid",
    originalObjective: "Changing direction under spatial pressure.",
    focusArea: "Dribbling",
    purpose: "Builds control and awareness in a crowded space.",
    cue: "Eyes up, find space and change direction.",
    summary:
      "Everyone dribbles inside a shrinking square, changing direction to avoid others and find space.",
    content: {
      description:
        "All players dribble inside a marked square. The square gradually shrinks, so players must change direction, protect the ball and find space more often. The pressure comes from the lack of room rather than from opponents.",
      skills: ["Close control", "Awareness", "Change of direction", "Spatial awareness"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 10,
      players: { min: 4, max: 20 },
      equipment: ["Cones for a square", "One ball per player"],
      setup: {
        layout: "A square marked with cones, all players inside with a ball each.",
        dimensions: DIM.grid,
      },
      steps: [
        "Players dribble freely in the large square, avoiding contact.",
        "The coach calls changes: turn, stop, speed up or use the weaker foot.",
        "Move the cones in to make the square smaller after a few minutes.",
        "Players keep the ball close and look for the next space.",
        "Finish in a larger square again so players feel the difference.",
      ],
      coachingPoints: [
        "Head up to scan for space before every touch.",
        "Quick, light touches and sharp turns.",
        "Protect the ball with your body when space closes.",
        "Use both feet.",
      ],
      commonMistakes: [
        "Dribbling in a straight line into others.",
        "Looking at the ball only.",
        "Kicking the ball away when it gets crowded.",
      ],
      progressions: {
        easier: [
          "Use a larger square.",
          "Fewer players in the square.",
        ],
        harder: [
          "Make the square smaller.",
          "Players must use only the weaker foot.",
        ],
      },
      safety: [
        "Dribble with control and avoid collisions; the coach stops play if the square becomes too crowded.",
        SAFE.balls,
        SAFE.surface,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["dribbling", "grid", "awareness", "space"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact shrinking-grid format was located."),
      ],
      diagram: grid({
        players: [
          P(28, 16, "A"),
          Ball(31, 18),
          P(52, 12, "A"),
          Ball(55, 14),
          P(70, 24, "A"),
          Ball(73, 26),
          P(36, 38, "A"),
          Ball(39, 40),
          P(60, 44, "A"),
          Ball(63, 46),
          Drib(28, 16, 24, 28, 1),
          Drib(70, 24, 78, 36, 2),
          Drib(36, 38, 46, 48, 3),
        ],
        caption:
          "Players dribble in a square, changing direction to find space; the cones move in to shrink the area.",
      }),
    },
  }),
  drill({
    number: 13,
    categoryId: cat,
    name: "Blindfold Soccer Movements",
    originalObjective: "Proprioception and spatial awareness without vision.",
    focusArea: "Off-the-ball movement",
    purpose: "Builds balance and awareness of body position.",
    cue: "Slow, controlled movements, always supervised.",
    summary:
      "A supervised, individual balance and body-awareness activity with eyes closed in marked lanes. Minimum age 12.",
    interpretation:
      "Redesigned as a controlled, supervised proprioception activity: eyes closed only, no physical blindfold by default, stationary or slow controlled movements only, in individual marked lanes. Nothing is claimed about injury prevention or rehabilitation.",
    minimumAge: { years: 12, basis: "INTERNAL_PRODUCT_POLICY" },
    content: {
      description:
        "Each player works alone in their own marked lane with eyes closed. They perform slow, controlled movements such as shifting weight, balancing on one foot and stepping around a stationary ball, while a spotter outside the lane watches. There is no running, passing, travelling with the ball or contact. Taking part is voluntary and anyone can stop immediately without giving a reason.",
      skills: ["Balance", "Body awareness", "Spatial awareness", "Concentration"],
      ageBands: ["U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 6,
      players: { min: 2, max: 12, note: "Each player needs a spotter outside the lane" },
      equipment: [
        "Cones to mark individual lanes",
        "One stationary ball per player",
        "No blindfolds are supplied by default; players simply close their eyes",
      ],
      setup: {
        layout:
          "Individual lanes marked with cones, each with nothing inside it except the player's own stationary ball. A spotter stands outside each lane.",
        dimensions:
          "Each lane is large enough for the player to move slowly without leaving it, with a clear buffer to the next lane and to any hazard. The coach sets the size for the group.",
      },
      steps: [
        "The coach explains the activity, the stop signal and the rule that anyone may stop at any time without giving a reason.",
        "Each player stands in their own lane with a stationary ball and the spotter outside the lane.",
        "With eyes open, rehearse the movement once slowly.",
        "Close the eyes only while standing still or moving slowly: shift weight from foot to foot, balance on one foot, or step slowly around the stationary ball.",
        "Open the eyes at once on any sign of unsteadiness or on the coach's signal, and rest.",
        "Swap player and spotter roles.",
      ],
      coachingPoints: [
        "Slow and controlled; there is no reward for speed.",
        "Feel the body's position and weight rather than looking for it.",
        "Spotters watch calmly, stay outside the lane and are ready to say stop.",
        "Open your eyes whenever you feel unsteady.",
      ],
      commonMistakes: [
        "Moving too quickly with eyes closed.",
        "Leaving the lane.",
        "A spotter looking away or entering the lane.",
      ],
      progressions: {
        easier: [
          "Keep eyes open and focus on feel.",
          "Stand still and shift weight only.",
        ],
        harder: [
          "Hold single-leg balance for slightly longer.",
          "Change the foot used for stepping around the ball.",
        ],
      },
      safety: [
        "Internal Sportozen restriction: minimum age 12. This is a conservative product rule, not a football association rule.",
        "Eyes closed only; no physical blindfold is used by default. Eyes closed only for stationary or slow, controlled movements.",
        "No running, no collisions, no passing and no contact. Lanes are individual with a clear buffer and nothing in them but the player's stationary ball.",
        "A spotter and the coach supervise throughout. Participation is voluntary, and any player may stop immediately without explanation.",
        SAFE.surface,
      ],
      phase: "WARM_UP",
      intensity: "LOW",
      tags: ["balance", "awareness", "supervised", "individual", "eyes closed"],
      references: [
        limitation(
          "No authoritative football-association source for an eyes-closed proprioception activity was located. The activity is deliberately limited, and the age restriction is an internal product policy.",
        ),
      ],
      diagram: layout(
        "grid",
        "GRID",
        [
          Zone(12, 10, 22, 40, "Lane 1"),
          Zone(39, 10, 22, 40, "Lane 2"),
          Zone(66, 10, 22, 40, "Lane 3"),
          P(23, 30, "A", "EC"),
          P(50, 30, "A", "EC"),
          P(77, 30, "A", "EC"),
          Ball(27, 36),
          Ball(54, 36),
          Ball(81, 36),
          P(23, 57, "N", "S"),
          P(50, 57, "N", "S"),
          P(77, 57, "N", "S"),
          Text(50, 5, "Eyes closed (EC); spotters (S) stay outside the lanes"),
        ],
        "Three separate lanes: each player (EC, eyes closed) stands still beside a stationary ball with a spotter (S) outside the lane.",
      ),
    },
  }),
  drill({
    number: 14,
    categoryId: cat,
    name: "Feint and Take-Off Drill",
    originalObjective: "Body drops, shoulder feints, and acceleration.",
    focusArea: "Dribbling",
    purpose: "Practises fooling an opponent and speeding away.",
    cue: "Sell the feint, then accelerate.",
    summary:
      "Players dribble at a cone as a defender, perform a body drop or shoulder feint, then accelerate past.",
    content: {
      description:
        "Players dribble towards a cone or a passive defender, perform a body drop or a shoulder feint to unbalance the opponent, and then take off past them with a burst of pace. The practice joins feint technique to the acceleration that makes it work in a game.",
      skills: ["Feints", "Acceleration", "Balance", "Close control"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 10,
      players: { min: 2, max: 16 },
      equipment: ["Cones as defenders", "One ball per player", "Bibs"],
      setup: {
        layout:
          "Several short lanes, each with a cone as the defender partway along and a finish line beyond.",
        dimensions: DIM.lane,
      },
      steps: [
        "Dribble at the cone with controlled speed.",
        "Just before the cone, perform the feint: drop the shoulder or move the body one way.",
        "Push the ball the other way with the outside or inside of the foot.",
        "Accelerate past the cone and across the finish line.",
        "Return along the outside and repeat on the other side.",
      ],
      coachingPoints: [
        "Commit your whole body to the feint, not only the foot.",
        "Keep the ball close during the feint.",
        "A sharp first step away makes the move work.",
        "Look up to see the defender's reaction.",
      ],
      commonMistakes: [
        "Slowing down before the feint.",
        "A feint with no change of direction.",
        "Stopping after beating the cone.",
      ],
      progressions: {
        easier: [
          "Use a stationary cone and walk through the move.",
          "Practise without the ball first.",
        ],
        harder: [
          "Replace the cone with a passive defender.",
          "Use a defender who reacts.",
        ],
      },
      safety: [
        "When a defender replaces the cone they stay passive until the coach says otherwise, and there is no tackling.",
        SAFE.surface,
        SAFE.space,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["feints", "dribbling", "acceleration", "1v1"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact drill was located."),
      ],
      diagram: layout(
        "slalom",
        "LANE",
        [
          P(10, 32, "A"),
          Ball(14, 32),
          C(52, 32),
          Drib(14, 32, 44, 32, 1),
          Drib(44, 32, 56, 22, 2),
          Run(58, 22, 90, 22, 3),
          Mark(10, 46, "Start"),
          Mark(90, 46, "Finish"),
          Text(52, 42, "Feint here"),
        ],
        "A player dribbles at a cone, feints one way, pushes the other and accelerates away.",
      ),
    },
  }),
  drill({
    number: 15,
    categoryId: cat,
    name: "Shielding the Ball",
    originalObjective: "Back-to-defender retention under light pressure.",
    focusArea: "Ball protection",
    purpose: "Teaches protecting the ball with the body.",
    cue: "Stay low and keep your body between the ball and the defender.",
    summary:
      "Attackers keep the ball with their back to a defender who applies light pressure, building retention skills.",
    content: {
      description:
        "An attacker receives the ball with their back to a defender and keeps it by using the body as a shield. The defender applies only light pressure at first. It trains balance, body positioning and awareness of where the defender is.",
      skills: ["Ball protection", "Body position", "Balance", "Awareness"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 10,
      players: { min: 2, max: 16 },
      equipment: ["One ball per pair", "Cones for grids", "Bibs"],
      setup: {
        layout: "Pairs in separate small grids, one attacker with the ball and one defender behind them.",
        dimensions: DIM.grid,
      },
      steps: [
        "The attacker stands side-on with the ball on the foot furthest from the defender.",
        "The defender applies light pressure from behind and tries to win the ball.",
        "The attacker keeps their body between the ball and the defender, and uses small touches to stay in control.",
        "After a short period the pair swaps roles.",
        "Increase pressure only as the attacker's control improves.",
      ],
      coachingPoints: [
        "Low centre of gravity and wide base.",
        "Arms and body shape the shield; no pushing or holding.",
        "Keep the ball on the far foot.",
        "Look over the shoulder to know where the defender is.",
      ],
      commonMistakes: [
        "Standing upright.",
        "Turning the back fully and losing sight of the defender.",
        "Defender grabbing the attacker's shirt.",
      ],
      progressions: {
        easier: [
          "Defender applies token pressure only.",
          "Larger grid and more time.",
        ],
        harder: [
          "Defender presses actively but fairly.",
          "Attacker must turn away and pass to a target.",
        ],
      },
      safety: [
        SAFE.contact,
        "No pushing, holding or pulling; challenges are for the ball only. The coach stops any rough play.",
        SAFE.space,
      ],
      phase: "MAIN",
      intensity: "MEDIUM",
      tags: ["shielding", "ball protection", "1v1", "retention"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact pairs format was located."),
      ],
      diagram: grid({
        players: [
          P(36, 30, "A"),
          Ball(33, 32),
          P(46, 30, "B"),
          Run(46, 30, 41, 30, 1),
          Drib(33, 34, 30, 40, 2),
          P(66, 30, "A"),
          Ball(63, 32),
          P(76, 30, "B"),
        ],
        caption:
          "Two pairs: each attacker (A) keeps their body between the ball and the defender (B), who presses lightly from behind.",
      }),
    },
  }),
];
