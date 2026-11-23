import type { UniversalDrill } from "@/domain/drill-library";
import {
  Ball,
  C,
  Drib,
  Mark,
  P,
  Pass,
  Run,
  Zone,
  grid,
  layout,
  rondo,
} from "./diagrams";
import { DIM, REF, SAFE, drill, limitation } from "./define";

const cat = "warm-up-activation" as const;

export const warmUpActivation: UniversalDrill[] = [
  drill({
    number: 1,
    categoryId: cat,
    name: "Dynamic Mobility Circuit",
    originalObjective: "Hip openers, gate swings, and lunges.",
    focusArea: "Off-the-ball movement",
    purpose: "Prepares the body for training with controlled moving exercises.",
    cue: "Move smoothly and stay balanced.",
    summary:
      "A station circuit of controlled hip openers, gate swings and lunges to prepare the body for the session.",
    content: {
      description:
        "Players move around three stations, each with one controlled mobility movement: hip openers, gate swings and lunges. The pace is easy and the quality of each movement matters more than speed. It is a ball-free start to a session.",
      skills: ["Mobility", "Balance", "Body control"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 8,
      players: { min: 4, max: 20 },
      equipment: ["Cones to mark three stations"],
      setup: {
        layout:
          "Three stations in a loop, each marked with a cone and a name card or the coach's call. Players start in small groups at the first station.",
        dimensions: DIM.grid,
      },
      steps: [
        "Show each movement once, slowly, before the group starts.",
        "Groups begin at different stations so no station is crowded.",
        "At the first station players open the hips by lifting the knee and rotating it out and back, alternating sides.",
        "At the second station players swing each leg across the body and out to the side like a gate, holding balance on the standing leg.",
        "At the third station players step into controlled lunges, keeping the front knee steady and the chest tall.",
        "On the coach's signal groups rotate to the next station and repeat until the circuit is complete.",
      ],
      coachingPoints: [
        "Smooth, controlled movements, never forced or bouncing.",
        "Tall posture and eyes up.",
        "Balance on the standing leg before moving the other.",
        "Breathe normally throughout.",
      ],
      commonMistakes: [
        "Rushing through the movements.",
        "Letting the knee fall inward in lunges.",
        "Leaning back or slouching.",
      ],
      progressions: {
        easier: [
          "Use a wall or a partner's shoulder for balance.",
          "Show smaller movements with a shorter range.",
        ],
        harder: [
          "Link two movements without stopping.",
          "Add a gentle jog between stations.",
        ],
      },
      safety: [
        "Players move within their own comfortable range; nobody is pushed to stretch further.",
        SAFE.surface,
        SAFE.stop,
      ],
      phase: "WARM_UP",
      intensity: "LOW",
      tags: ["warm-up", "mobility", "no ball", "balance"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact circuit was located."),
      ],
      diagram: layout(
        "grid",
        "GRID",
        [
          Zone(8, 8, 84, 48),
          Mark(22, 32, "1 Hip openers"),
          Mark(50, 20, "2 Gate swings"),
          Mark(78, 32, "3 Lunges"),
          C(22, 38),
          C(50, 26),
          C(78, 38),
          P(14, 44, "A"),
          P(18, 50, "A"),
          P(42, 36, "A"),
          P(70, 44, "A"),
          Run(26, 40, 46, 30, 1),
          Run(54, 28, 74, 38, 2),
          Run(80, 46, 28, 48, 3),
        ],
        "Players rotate around three marked stations: hip openers, gate swings and lunges.",
      ),
    },
  }),
  drill({
    number: 2,
    categoryId: cat,
    name: "4-Grid Warm-Up",
    originalObjective: "Passing, reactions, and light speed work.",
    focusArea: "Passing",
    purpose: "Warms up with passing, quick reactions and light running.",
    cue: "Pass, move and be ready.",
    summary:
      "Four connected grids where players pass, react to calls and build up to light speed work before the main practice.",
    content: {
      description:
        "The pitch area is split into four grids. In each grid a small group passes and moves, reacts to the coach's call and finishes with a short, light run. Intensity rises gradually, so the whole squad is warm and active within a few minutes.",
      skills: ["Passing", "Reactions", "Movement", "Communication"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 10,
      players: { min: 8, max: 24, note: "Groups of about four per grid" },
      equipment: ["Cones for four grids", "One ball per group"],
      setup: {
        layout:
          "Four grids side by side or in a square. One group of players with one ball in each grid.",
        dimensions: DIM.grid,
      },
      steps: [
        "Each group passes the ball around the grid, moving after every pass.",
        "On the coach's call (a colour, a number or a word) the group changes what it is doing, for example one touch or a change of direction.",
        "On a second call one player from each group takes a light run across the grid and back, then rejoins.",
        "Build the pace of passing and running step by step across the practice.",
        "Rotate groups to a different grid so each group meets new passing partners.",
      ],
      coachingPoints: [
        "Pass with the inside of the foot and receive on the move.",
        "Look up before receiving, then call for the ball.",
        "React quickly to calls but stay controlled.",
        "Build speed gradually; start easy.",
      ],
      commonMistakes: [
        "Standing still after passing.",
        "Passing too hard for the first minutes.",
        "Not listening for the coach's call.",
      ],
      progressions: {
        easier: [
          "Pass in pairs with no calls.",
          "Use a bigger grid with fewer players.",
        ],
        harder: [
          "Limit touches.",
          "Add a second ball in each grid.",
        ],
      },
      safety: [
        "Keep each group inside its own grid and avoid crossing between grids.",
        SAFE.balls,
        SAFE.water,
      ],
      phase: "WARM_UP",
      intensity: "LOW",
      tags: ["warm-up", "passing", "reactions", "grids"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact four-grid layout was located."),
      ],
      diagram: grid({
        players: [
          Zone(18, 6, 30, 24, "Grid 1"),
          Zone(52, 6, 30, 24, "Grid 2"),
          Zone(18, 34, 30, 24, "Grid 3"),
          Zone(52, 34, 30, 24, "Grid 4"),
          P(24, 12, "A"),
          P(42, 12, "A"),
          P(33, 24, "A"),
          P(58, 12, "B"),
          P(76, 12, "B"),
          P(67, 24, "B"),
          Ball(26, 14),
          Pass(26, 13, 40, 13, 1),
          Pass(41, 14, 34, 23, 2),
          Run(60, 14, 75, 25, 3),
        ],
        caption:
          "Four grids, each with a small group passing and moving; one group is shown passing and one making a light run.",
        area: { x: 16, y: 4, w: 68, h: 56 },
      }),
    },
  }),
  drill({
    number: 3,
    categoryId: cat,
    name: "Ball-Feel Coordination",
    originalObjective: "Toe-taps, roll-overs, and sole-shuffles.",
    focusArea: "Dribbling",
    purpose: "Builds comfort and coordination with the ball at the feet.",
    cue: "Light touches, eyes up.",
    summary:
      "Each player works with their own ball on toe-taps, roll-overs and sole-shuffles to wake up the feet.",
    content: {
      description:
        "Every player has a ball and works in their own space on three simple foot skills: toe-taps, roll-overs and sole-shuffles. The aim is relaxed, rhythmic, light contact. It prepares both feet and the mind for the practice that follows.",
      skills: ["Ball mastery", "Coordination", "Balance", "Both feet"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 8,
      players: { min: 1, max: 24 },
      equipment: ["One ball per player"],
      setup: {
        layout: "Players spread out in a marked area, each with a ball and space around them.",
        dimensions: DIM.grid,
      },
      steps: [
        "Toe-taps: tap the top of the ball alternately with the sole or toes of each foot, staying light on the standing foot.",
        "Roll-overs: roll the ball across the body with the sole, then back with the other foot.",
        "Sole-shuffles: draw the ball sideways and back with the sole in a shuffling rhythm.",
        "Change from one skill to the next on the coach's call.",
        "Repeat each skill with the other foot and then with both feet together.",
      ],
      coachingPoints: [
        "Relaxed ankles and light, quick touches.",
        "Look up regularly, not only down at the ball.",
        "Use both feet equally.",
        "Keep the ball close.",
      ],
      commonMistakes: [
        "Staring at the ball the whole time.",
        "Tapping too hard so the ball runs away.",
        "Using only the stronger foot.",
      ],
      progressions: {
        easier: [
          "Slow down and do one foot at a time.",
          "Use a bigger, softer ball.",
        ],
        harder: [
          "Link two skills without a pause.",
          "Travel slowly across the area while performing a skill.",
        ],
      },
      safety: [
        "Players stay in their own space and keep an eye on others near them.",
        SAFE.surface,
        SAFE.balls,
      ],
      phase: "WARM_UP",
      intensity: "LOW",
      tags: ["warm-up", "ball mastery", "coordination", "individual"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact skill set was located."),
      ],
      diagram: grid({
        players: [
          P(30, 18, "A"),
          Ball(33, 20),
          P(62, 18, "A"),
          Ball(65, 20),
          P(30, 42, "A"),
          Ball(33, 44),
          P(62, 42, "A"),
          Ball(65, 44),
          Drib(30, 23, 34, 28, 1),
          Drib(62, 23, 58, 28, 2),
        ],
        caption:
          "Each player works with their own ball in their own space; short arrows show small touches, not travel.",
      }),
    },
  }),
  drill({
    number: 4,
    categoryId: cat,
    name: "Tag Game with Balls",
    originalObjective: "Dribbling in a grid while trying to tag others.",
    focusArea: "Dribbling",
    purpose: "A fun game that builds dribbling and awareness.",
    cue: "Keep the ball close and look around.",
    summary:
      "Everyone dribbles inside a grid while the taggers try to touch other players. A lively, game-like warm-up.",
    content: {
      description:
        "All players dribble a ball inside a marked grid. One or two players are taggers and try to touch others on the back or shoulder with a hand while also dribbling. A tagged player becomes a tagger or does a quick skill and rejoins. It builds close control and head-up awareness in a game format.",
      skills: ["Dribbling", "Awareness", "Change of direction", "Close control"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14"],
      difficulty: "BEGINNER",
      durationMinutes: 8,
      players: { min: 6, max: 20 },
      equipment: ["One ball per player", "Cones to mark the grid", "Bibs for taggers"],
      setup: {
        layout: "A square grid with every player dribbling inside it. Taggers wear bibs.",
        dimensions: DIM.grid,
      },
      steps: [
        "Everyone dribbles freely inside the grid.",
        "Choose one or two taggers, who also dribble and try to tag others with a gentle touch of the hand on the back or shoulder.",
        "A tagged player does a quick ball skill, such as a few toe-taps, and rejoins the game.",
        "If a ball leaves the grid its owner collects it and re-enters at once.",
        "Change taggers every round so everyone has a turn.",
      ],
      coachingPoints: [
        "Keep the ball close so it does not roll away.",
        "Eyes up to see space and the taggers.",
        "Use quick changes of direction and speed.",
        "Protect the ball by keeping your body between it and the tagger.",
      ],
      commonMistakes: [
        "Kicking the ball away to run faster.",
        "Looking only at the ball.",
        "Tagging roughly.",
      ],
      progressions: {
        easier: [
          "Use a bigger grid with fewer taggers.",
          "Taggers do not need to dribble.",
        ],
        harder: [
          "Shrink the grid.",
          "Players must use their weaker foot when tagged.",
        ],
      },
      safety: [
        "Tags are a light touch of the hand on the back or shoulder only: no pushing, pulling or grabbing.",
        "Keep balls under control so players do not collide; stop and reset if the grid becomes crowded.",
        SAFE.balls,
      ],
      phase: "WARM_UP",
      intensity: "MEDIUM",
      tags: ["warm-up", "dribbling", "game", "tag"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact variant was located."),
      ],
      diagram: grid({
        players: [
          P(28, 16, "A"),
          Ball(31, 18),
          P(60, 14, "A"),
          Ball(63, 16),
          P(70, 38, "A"),
          Ball(73, 40),
          P(30, 44, "A"),
          Ball(33, 46),
          P(48, 30, "B", "T"),
          Ball(51, 32),
          Run(48, 30, 36, 20, 1),
          Drib(60, 14, 52, 22, 2),
          Drib(70, 38, 60, 46, 3),
        ],
        caption:
          "Players (A) dribble inside the grid; the tagger (T) chases and touches others gently.",
      }),
    },
  }),
  drill({
    number: 5,
    categoryId: cat,
    name: "Two-Touch Juggling Circle",
    originalObjective: "Air/bounce control with partners.",
    focusArea: "First touch and receiving",
    purpose: "Builds control of the ball in the air and on the bounce.",
    cue: "Soft touch, then pass to your partner.",
    summary:
      "Players in a circle control the ball in the air or after a bounce with two touches, then pass on.",
    interpretation:
      "'Two-touch' is read as: each player takes at most two touches (a control and a pass) before the ball moves on. It is not a juggling count.",
    content: {
      description:
        "Players stand in a circle, or in pairs, and pass the ball to each other so it arrives in the air or after a bounce. Each player controls it with a first touch and passes with a second. It develops soft receiving and accurate, gentle service.",
      skills: ["First touch", "Aerial control", "Passing", "Communication"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "INTERMEDIATE",
      durationMinutes: 8,
      players: { min: 4, max: 12 },
      equipment: ["One or two balls per circle"],
      setup: {
        layout: "Players form a circle, or stand in pairs facing each other, with space between groups.",
        dimensions: DIM.grid,
      },
      steps: [
        "A player gently serves the ball to a partner so it bounces once or arrives low in the air.",
        "The receiver controls it with a soft first touch using the foot, thigh or chest.",
        "With the second touch the receiver passes to another player or back to the partner.",
        "Keep the ball moving around the circle, calling the name of the player you pass to.",
        "Swap partners regularly so players receive from different angles.",
      ],
      coachingPoints: [
        "Cushion the ball by relaxing the contact surface as it arrives.",
        "Get into the line of the ball early.",
        "Gentle, accurate service helps your partner.",
        "Call the receiver's name before passing.",
      ],
      commonMistakes: [
        "Stiff legs that make the ball bounce away.",
        "Serving too hard or too high.",
        "Not moving into the line of the ball.",
      ],
      progressions: {
        easier: [
          "Let the ball bounce twice before controlling.",
          "Use a lighter ball.",
        ],
        harder: [
          "Increase the pace of service.",
          "Use only one touch for control.",
        ],
      },
      safety: [
        "Serve low and gentle, especially for younger players, so the ball never arrives at the face.",
        "Use chest, thigh or foot for control; this drill does not use the head.",
        SAFE.balls,
      ],
      phase: "WARM_UP",
      intensity: "LOW",
      tags: ["warm-up", "first touch", "aerial control", "circle"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact circle format was located."),
      ],
      diagram: rondo({
        outer: 6,
        inner: 0,
        shape: "circle",
        caption:
          "Players in a circle serve to each other for a soft first touch and a second-touch pass.",
      }),
    },
  }),
  drill({
    number: 6,
    categoryId: cat,
    name: "Shadow Play",
    originalObjective: "Mirroring an opponent's movements without the ball.",
    focusArea: "Off-the-ball movement",
    purpose: "Builds quick feet, balance and reaction without the ball.",
    cue: "Stay balanced and copy your partner.",
    summary:
      "Pairs mirror each other's movements without a ball, practising quick feet, balance and reactions.",
    content: {
      description:
        "Players work in pairs. One leads with changes of direction and pace; the other mirrors as closely as possible, like a shadow. Roles swap often. It warms the body and trains the balanced stance and fast reactions used when marking an opponent.",
      skills: ["Agility", "Reaction", "Balance", "Body position"],
      ageBands: ["U6-U8", "U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 8,
      players: { min: 2, max: 20 },
      equipment: ["Cones to mark the area"],
      setup: {
        layout: "Pairs face each other inside a marked area, with clear space between pairs.",
        dimensions: DIM.grid,
      },
      steps: [
        "One player leads with small steps to the side, forwards and back; the partner mirrors.",
        "The leader adds quick changes of direction and pace.",
        "On the coach's call the pairs swap roles.",
        "Allow the mirror player to keep a gap and not touch the leader.",
        "Finish with a short, light race to a line, leader against follower.",
      ],
      coachingPoints: [
        "Stay low and balanced on the balls of the feet.",
        "Keep your eyes on your partner's hips and trunk, not the feet.",
        "Use small, quick steps rather than big strides.",
        "Stay relaxed and keep breathing.",
      ],
      commonMistakes: [
        "Crossing the feet.",
        "Standing tall and flat-footed.",
        "Watching the feet and falling for fakes.",
      ],
      progressions: {
        easier: [
          "Slow the leader down.",
          "Restrict movement to one line.",
        ],
        harder: [
          "Add a ball for the leader.",
          "Mirror over a larger space.",
        ],
      },
      safety: [
        "Keep a gap between partners so there is no contact, and keep pairs well apart.",
        SAFE.space,
        SAFE.surface,
      ],
      phase: "WARM_UP",
      intensity: "MEDIUM",
      tags: ["warm-up", "agility", "reactions", "no ball", "pairs"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for this exact mirroring drill was located."),
      ],
      diagram: grid({
        players: [
          P(28, 22, "A", "L"),
          P(28, 38, "B", "M"),
          P(66, 22, "A", "L"),
          P(66, 38, "B", "M"),
          Run(28, 22, 38, 22, 1),
          Run(28, 38, 38, 38, 2),
          Run(66, 22, 56, 22, 3),
          Run(66, 38, 56, 38, 4),
        ],
        caption:
          "Two pairs: the leader (L) moves and the mirror player (M) copies, without a ball and without contact.",
      }),
    },
  }),
  drill({
    number: 7,
    categoryId: cat,
    name: "Dynamic Sprint & Acceleration",
    originalObjective: "Gradual build-up runs from 50% to 100%.",
    focusArea: "Off-the-ball movement",
    purpose: "Builds running speed gradually from an easy start.",
    cue: "Start easy, then speed up smoothly.",
    summary:
      "Players run along a lane, speeding up smoothly from an easy pace to full speed, with full recovery between runs.",
    interpretation:
      "The approved '50% to 100%' is read as an effort build-up within each run (easy to full speed). Sportozen sets no number of runs or distances; the coach decides.",
    content: {
      description:
        "Players take turns running along a marked lane. Each run starts at an easy pace and builds smoothly to full speed by the end, with a walk-back for recovery. Early runs are easier, and the full-speed effort comes only once the body is warm. It prepares for speed work in the main practice.",
      skills: ["Acceleration", "Running technique", "Body awareness"],
      ageBands: ["U9-U11", "U12-U14", "U15+"],
      difficulty: "BEGINNER",
      durationMinutes: 8,
      players: { min: 2, max: 20 },
      equipment: ["Cones to mark the lane and zones"],
      setup: {
        layout:
          "A straight lane marked into a start zone, a build-up zone and a finish zone, with a safe run-off area beyond the finish.",
        dimensions: DIM.lane,
      },
      steps: [
        "Players line up at the start in turn, with room to run.",
        "Run one is an easy pace, then each later run builds to a faster effort.",
        "Within each run, begin easy, increase the pace through the build-up zone and reach top speed near the finish.",
        "Slow down gradually in the run-off area; do not stop suddenly.",
        "Walk back along the side of the lane to recover before the next run.",
      ],
      coachingPoints: [
        "Smooth build-up rather than an instant sprint.",
        "Tall posture, relaxed shoulders and arms driving.",
        "Land on the front of the foot and push away.",
        "Full recovery between runs, so each run is quality.",
      ],
      commonMistakes: [
        "Sprinting flat out from the first step.",
        "Stopping suddenly at the finish.",
        "Walking back across the lane of other runners.",
      ],
      progressions: {
        easier: [
          "Keep every run at an easy-to-medium effort.",
          "Run in pairs side by side at the same pace.",
        ],
        harder: [
          "Start from different positions such as a crouch or a turn.",
          "Add a ball to dribble in the final part.",
        ],
      },
      safety: [
        "Only one player runs in a lane at a time, and the run-off area is kept clear.",
        "Players warm up before the faster runs; the coach decides the number of runs and rest by watching technique and fatigue.",
        SAFE.surface,
        SAFE.water,
      ],
      phase: "WARM_UP",
      intensity: "MEDIUM",
      tags: ["warm-up", "speed", "acceleration", "lane"],
      references: [
        REF.uefaGrassroots,
        limitation("No published source for the exact 50% to 100% build-up was located; no distances or number of runs are specified."),
      ],
      diagram: layout(
        "grid",
        "LANE",
        [
          Zone(8, 24, 24, 16, "Easy"),
          Zone(32, 24, 28, 16, "Build"),
          Zone(60, 24, 24, 16, "Full speed"),
          Zone(84, 24, 12, 16, "Run-off"),
          C(8, 24),
          C(8, 40),
          C(84, 24),
          C(84, 40),
          P(12, 32, "A"),
          Run(14, 32, 36, 32, 1),
          Run(38, 32, 62, 32, 2),
          Run(64, 32, 86, 32, 3),
          Mark(10, 48, "Start"),
          Mark(70, 48, "Finish"),
        ],
        "A lane in three zones: build from an easy pace through the middle zone to full speed, then a clear run-off.",
      ),
    },
  }),
];
