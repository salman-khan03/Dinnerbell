/**
 * Dinner Bell engine types.
 *
 * Everything in here is plain, JSON-serialisable data so plans can be stored,
 * replayed and sent over MCP without custom (de)serialisation.
 * All times are absolute *minutes since the Unix epoch* (see time.ts).
 */

/** How much of a cook's attention a task needs. */
export type Hands = 'full' | 'light' | 'none';

export type Appliance = 'oven' | 'burner' | 'slow_cooker' | 'air_fryer' | 'microwave' | 'grill';

/** One way a task can be cooked. The first entry in `TaskDef.uses` is preferred. */
export interface Use {
  appliance: Appliance;
  /** Oven / air-fryer / grill temperature in °F. */
  tempF?: number;
  /** How far (°F) this task tolerates sharing the oven with a different temperature. Default 25. */
  tempFlex?: number;
  /** Oven rack slots the task occupies (a whole roast = 2, a sheet pan or casserole = 1). */
  slots?: 1 | 2;
  /** Multiplier on the task's minutes when cooked this way (air fryer is faster). */
  minutesFactor?: number;
}

/** A dependency, optionally with a resting window (min/max gap) between the two tasks. */
export interface Dep {
  /** Task id inside the same dish, or `dishId.taskId` for a cross-dish dependency. */
  task: string;
  /** The dependent task may not start until this many minutes after the predecessor ends. */
  minGap?: number;
  /** ...and must start within this many minutes after the predecessor ends. */
  maxGap?: number;
  /** Shown on the timeline as a rest period, e.g. "Turkey rests". */
  gapLabel?: string;
}

export interface TaskDef {
  id: string;
  /** Short imperative sentence that reads well aloud. */
  label: string;
  /** Base minutes (at quantity 0). */
  minutes: number;
  /** Extra minutes per unit of the dish's quantity (e.g. 13 min per pound of turkey). */
  perUnit?: number;
  /** Prep-style task that grows (sub-linearly) with the number of servings. */
  scalesWithServings?: boolean;
  hands: Hands;
  uses?: Use[];
  after?: (string | Dep)[];
  /** Can be done ahead of the cooking window; value = how many minutes ahead at most. */
  makeAhead?: number;
}

export type Course = 'main' | 'side' | 'starter' | 'bread' | 'dessert';

export interface DishDef {
  id: string;
  name: string;
  aliases?: string[];
  course: Course;
  cuisine: string;
  tags: string[];
  /** Servings the base recipe makes. */
  servings: number;
  /** For dishes sized by weight (roasts). */
  unit?: { name: string; perGuest: number; min: number; max: number };
  /** How long the finished dish can wait (covered / warm) before it hurts. 0 = serve at once. */
  holdMin: number;
  tasks: TaskDef[];
  /** Things to do days before the cooking window (thawing, shopping). */
  prework?: string[];
  blurb?: string;
}

export interface Kitchen {
  ovens: number;
  burners: number;
  /** People cooking at the same time. */
  cooks: number;
  /** Extra appliances and how many of each. */
  extras: Partial<Record<Exclude<Appliance, 'oven' | 'burner'>, number>>;
}

export interface PlanDish {
  dishId: string;
  /** Weight for weight-sized dishes. Defaults from the guest count. */
  quantity?: number;
  /** Servings override; defaults to the guest count. */
  servings?: number;
}

export interface PlanInput {
  /** When the food should reach the table. */
  serveAt: number;
  /** Earliest moment the cook can begin. */
  startAt: number;
  guests: number;
  dishes: PlanDish[];
  kitchen: Kitchen;
  /** Minutes of cushion the plan aims for before the serve time. */
  marginMin: number;
  /** IANA time zone for spoken times. */
  tz: string;
  /** Household-defined dishes (grandma's recipes). */
  custom?: DishDef[];
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'skipped';

export interface TaskProgress {
  status: 'running' | 'done' | 'skipped';
  startedAt?: number;
  doneAt?: number;
  /** When running: minutes still needed, if the cook says it differs from the plan. */
  remainingMin?: number;
}

export type Progress = Record<string, TaskProgress>;

export interface ScheduledTask {
  /** `dishId.taskId` */
  key: string;
  dishId: string;
  dishName: string;
  taskId: string;
  label: string;
  startMin: number;
  endMin: number;
  hands: Hands;
  /** The way this task is actually being cooked. */
  use?: Use;
  /** Which appliance instance, e.g. `oven-1`. */
  resource?: string;
  status: TaskStatus;
  /** Scheduled before the cooking window opens. */
  preWork: boolean;
  notes: string[];
}

export interface RestPeriod {
  fromKey: string;
  toKey: string;
  startMin: number;
  endMin: number;
  label: string;
}

export type PlanState = 'on_track' | 'tight' | 'late' | 'impossible';

export interface Insight {
  kind: 'helper' | 'drop_dish' | 'start_earlier' | 'appliance' | 'info';
  message: string;
  /** Minutes this would recover (when meaningful). */
  savesMin?: number;
}

export interface Schedule {
  state: PlanState;
  requestedServeMin: number;
  /** Earliest time everything can actually be ready given progress so far. */
  achievableServeMin: number;
  /** Minutes the plan could absorb before serve time slips. Negative = already late. */
  bufferMin: number;
  tasks: ScheduledTask[];
  rests: RestPeriod[];
  prework: { text: string; when?: string; key?: string }[];
  warnings: string[];
  insights: Insight[];
  generatedAtMin: number;
  /** First moment the cook has to do something. */
  firstActionMin: number;
}
