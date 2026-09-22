/**
 * The dish library. Each dish is a small task graph with realistic timings.
 *
 * The interesting part is what makes a multi-dish meal hard, and it is all
 * encoded here as data:
 *   - the turkey occupies the whole oven, then *rests* (a min/max gap) which is
 *     the only window where the sides can bake;
 *   - gravy needs the turkey's drippings (a cross-dish dependency);
 *   - mashed potatoes must be mashed within minutes of draining;
 *   - pie must cool for two hours, so it wants to be made the day before.
 */
import type { DishDef, Dep, Hands, TaskDef, Use } from './types.js';

const oven = (tempF: number, slots: 1 | 2 = 1, tempFlex = 25): Use => ({ appliance: 'oven', tempF, slots, tempFlex });
const burner: Use = { appliance: 'burner' };

interface TaskOpts {
  perUnit?: number;
  scales?: boolean;
  uses?: Use[];
  after?: (string | Dep)[];
  makeAhead?: number;
}
const task = (id: string, label: string, minutes: number, hands: Hands, o: TaskOpts = {}): TaskDef => ({
  id,
  label,
  minutes,
  hands,
  ...(o.perUnit ? { perUnit: o.perUnit } : {}),
  ...(o.scales ? { scalesWithServings: true } : {}),
  ...(o.uses ? { uses: o.uses } : {}),
  ...(o.after ? { after: o.after } : {}),
  ...(o.makeAhead ? { makeAhead: o.makeAhead } : {}),
});

const DAY = 1440;

export const DISHES: DishDef[] = [
  // ───────────────────────── American holiday ─────────────────────────
  {
    id: 'turkey',
    name: 'Roast turkey',
    aliases: ['turkey', 'thanksgiving turkey', 'roasted turkey'],
    course: 'main',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'gluten-free'],
    servings: 8,
    unit: { name: 'pounds', perGuest: 1.25, min: 8, max: 26 },
    holdMin: 30,
    blurb: 'Classic roast turkey, about 13 minutes a pound, with a proper rest.',
    prework: [
      'Thaw the turkey in the fridge, allowing one full day for every four pounds.',
      'Optional: dry-brine the turkey with salt the night before for juicier meat.',
    ],
    tasks: [
      task('prep', 'Pat the turkey dry, season it, and get it in the pan', 25, 'full'),
      task('roast', 'Roast the turkey', 0, 'none', { perUnit: 13, uses: [oven(325, 2)], after: [{ task: 'prep', maxGap: 30 }] }),
      task('carve', 'Carve the turkey', 15, 'full', {
        after: [{ task: 'roast', minGap: 30, maxGap: 60, gapLabel: 'Turkey rests' }],
      }),
    ],
  },
  {
    id: 'gravy',
    name: 'Turkey gravy',
    aliases: ['gravy'],
    course: 'side',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday'],
    servings: 8,
    holdMin: 40,
    blurb: 'Made from the pan drippings, so it waits for the turkey to come out.',
    tasks: [
      task('stock', 'Simmer stock from the neck and giblets', 50, 'light', { uses: [burner], makeAhead: DAY }),
      task('finish', 'Make the gravy from the pan drippings', 15, 'full', {
        uses: [burner],
        after: ['stock', { task: 'turkey.roast', maxGap: 45 }],
      }),
    ],
  },
  {
    id: 'mashed',
    name: 'Mashed potatoes',
    aliases: ['mashed potatoes', 'mash', 'potatoes'],
    course: 'side',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'vegetarian', 'gluten-free'],
    servings: 8,
    holdMin: 45,
    blurb: 'Peel, boil, mash, then hold covered and warm.',
    tasks: [
      task('peel', 'Peel and chop the potatoes', 20, 'full', { scales: true, makeAhead: 240 }),
      task('boil', 'Boil the potatoes until tender', 25, 'light', { uses: [burner], after: ['peel'] }),
      task('mash', 'Drain and mash with butter and cream', 10, 'full', { after: [{ task: 'boil', maxGap: 10 }] }),
    ],
  },
  {
    id: 'stuffing',
    name: 'Herb stuffing',
    aliases: ['stuffing', 'dressing'],
    course: 'side',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'vegetarian'],
    servings: 8,
    holdMin: 45,
    tasks: [
      task('prep', 'Cube the bread and saute the onion, celery, and herbs', 25, 'full', {
        scales: true,
        makeAhead: 720,
      }),
      task('bake', 'Bake the stuffing', 45, 'none', { uses: [oven(350)], after: ['prep'] }),
    ],
  },
  {
    id: 'green_bean',
    name: 'Green bean casserole',
    aliases: ['green beans', 'green bean casserole'],
    course: 'side',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'vegetarian'],
    servings: 8,
    holdMin: 40,
    tasks: [
      task('prep', 'Trim the beans and mix the mushroom sauce', 20, 'full', { scales: true, makeAhead: 720 }),
      task('bake', 'Bake the casserole, adding the crispy onions at the end', 30, 'none', {
        uses: [oven(350)],
        after: ['prep'],
      }),
    ],
  },
  {
    id: 'sweet_potatoes',
    name: 'Sweet potato casserole',
    aliases: ['sweet potatoes', 'yams', 'candied yams', 'sweet potato casserole'],
    course: 'side',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'vegetarian', 'gluten-free'],
    servings: 8,
    holdMin: 45,
    tasks: [
      task('boil', 'Boil the sweet potatoes until soft', 20, 'light', { uses: [burner], makeAhead: 720 }),
      task('mash', 'Mash and assemble the casserole', 20, 'full', { scales: true, after: [{ task: 'boil', maxGap: 30 }], makeAhead: 720 }),
      task('bake', 'Bake the casserole with the topping', 30, 'none', { uses: [oven(350)], after: ['mash'] }),
    ],
  },
  {
    id: 'cranberry',
    name: 'Cranberry sauce',
    aliases: ['cranberry', 'cranberries'],
    course: 'side',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'vegetarian', 'gluten-free'],
    servings: 8,
    holdMin: 3 * DAY,
    blurb: 'Wants to be made ahead so it can chill.',
    tasks: [
      task('simmer', 'Simmer the cranberries with sugar and orange', 15, 'light', { uses: [burner], makeAhead: 3 * DAY }),
      task('chill', 'Chill the cranberry sauce', 120, 'none', { after: [{ task: 'simmer', maxGap: 30 }], makeAhead: 3 * DAY }),
    ],
  },
  {
    id: 'rolls',
    name: 'Homemade dinner rolls',
    aliases: ['rolls', 'dinner rolls', 'homemade rolls', 'bread rolls'],
    course: 'bread',
    cuisine: 'American',
    tags: ['holiday', 'vegetarian'],
    servings: 12,
    holdMin: 20,
    tasks: [
      task('mix', 'Mix and knead the dough', 15, 'full', { makeAhead: 240 }),
      task('rise', 'Let the dough rise', 60, 'none', { after: [{ task: 'mix', maxGap: 15 }], makeAhead: 240 }),
      task('shape', 'Shape the rolls', 10, 'full', { after: [{ task: 'rise', maxGap: 30 }] }),
      task('bake', 'Bake the rolls', 15, 'none', { uses: [oven(375, 1, 25)], after: [{ task: 'shape', minGap: 20, maxGap: 45, gapLabel: 'Rolls rise again' }] }),
    ],
  },
  {
    id: 'rolls_store',
    name: 'Warm store-bought rolls',
    aliases: ['store bought rolls', 'store-bought rolls', 'brown and serve rolls'],
    course: 'bread',
    cuisine: 'American',
    tags: ['holiday', 'vegetarian', 'easy'],
    servings: 12,
    holdMin: 20,
    tasks: [task('warm', 'Warm the rolls in the oven', 10, 'light', { uses: [oven(350, 1, 50)] })],
  },
  {
    id: 'pumpkin_pie',
    name: 'Pumpkin pie',
    aliases: ['pumpkin pie', 'pie'],
    course: 'dessert',
    cuisine: 'American',
    tags: ['thanksgiving', 'holiday', 'vegetarian'],
    servings: 8,
    holdMin: 3 * DAY,
    blurb: 'Needs two hours to cool, so the planner will likely move it to the day before.',
    tasks: [
      task('make', 'Make the crust and pumpkin filling', 35, 'full', { makeAhead: 2 * DAY }),
      task('bake', 'Bake the pie', 60, 'none', { uses: [oven(375)], after: [{ task: 'make', maxGap: 30 }], makeAhead: 2 * DAY }),
      task('cool', 'Let the pie cool completely', 120, 'none', { after: [{ task: 'bake', maxGap: 15 }], makeAhead: 2 * DAY }),
    ],
  },
  {
    id: 'apple_pie',
    name: 'Apple pie',
    aliases: ['apple pie'],
    course: 'dessert',
    cuisine: 'American',
    tags: ['holiday', 'vegetarian'],
    servings: 8,
    holdMin: 3 * DAY,
    tasks: [
      task('make', 'Peel and slice the apples and roll the crust', 40, 'full', { makeAhead: 2 * DAY }),
      task('bake', 'Bake the apple pie', 55, 'none', { uses: [oven(375)], after: [{ task: 'make', maxGap: 30 }], makeAhead: 2 * DAY }),
      task('cool', 'Let the pie cool', 90, 'none', { after: [{ task: 'bake', maxGap: 15 }], makeAhead: 2 * DAY }),
    ],
  },
  {
    id: 'brussels',
    name: 'Roasted Brussels sprouts',
    aliases: ['brussels sprouts', 'brussel sprouts', 'sprouts'],
    course: 'side',
    cuisine: 'American',
    tags: ['holiday', 'vegetarian', 'gluten-free'],
    servings: 8,
    holdMin: 10,
    tasks: [
      task('trim', 'Trim and halve the sprouts', 15, 'full', { scales: true, makeAhead: 720 }),
      task('roast', 'Roast the sprouts until crisp', 25, 'none', {
        uses: [oven(425), { appliance: 'air_fryer', tempF: 400, minutesFactor: 0.6 }],
        after: ['trim'],
      }),
      task('toss', 'Toss with lemon and salt', 5, 'full', { after: [{ task: 'roast', maxGap: 10 }] }),
    ],
  },
  {
    id: 'mac',
    name: 'Baked mac and cheese',
    aliases: ['mac and cheese', 'mac n cheese', 'macaroni and cheese'],
    course: 'side',
    cuisine: 'American',
    tags: ['holiday', 'vegetarian'],
    servings: 8,
    holdMin: 20,
    tasks: [
      task('pasta', 'Boil the pasta', 12, 'light', { uses: [burner] }),
      task('sauce', 'Make the cheese sauce', 15, 'full', { uses: [burner], scales: true }),
      task('assemble', 'Combine and add the breadcrumb topping', 10, 'full', {
        after: [{ task: 'pasta', maxGap: 15 }, { task: 'sauce', maxGap: 15 }],
      }),
      task('bake', 'Bake until bubbly', 30, 'none', { uses: [oven(375)], after: ['assemble'] }),
    ],
  },
  {
    id: 'salad',
    name: 'Green salad',
    aliases: ['salad', 'garden salad', 'green salad', 'caesar salad'],
    course: 'starter',
    cuisine: 'American',
    tags: ['vegetarian', 'gluten-free', 'easy'],
    servings: 8,
    holdMin: 15,
    tasks: [
      task('wash', 'Wash and chop the greens', 15, 'full', { scales: true, makeAhead: 240 }),
      task('toss', 'Dress and toss the salad', 5, 'full', { after: ['wash'] }),
    ],
  },
  {
    id: 'garlic_bread',
    name: 'Garlic bread',
    aliases: ['garlic bread'],
    course: 'bread',
    cuisine: 'Italian',
    tags: ['vegetarian', 'easy'],
    servings: 8,
    holdMin: 10,
    tasks: [
      task('prep', 'Slice the loaf and spread with garlic butter', 10, 'full', { makeAhead: 240 }),
      task('bake', 'Bake the garlic bread', 12, 'none', { uses: [oven(400)], after: ['prep'] }),
    ],
  },
  {
    id: 'roasted_veg',
    name: 'Roasted root vegetables',
    aliases: ['roasted vegetables', 'root vegetables', 'roast veg', 'roasted veg'],
    course: 'side',
    cuisine: 'American',
    tags: ['vegetarian', 'gluten-free', 'holiday'],
    servings: 8,
    holdMin: 20,
    tasks: [
      task('chop', 'Peel and chop the vegetables', 20, 'full', { scales: true, makeAhead: 720 }),
      task('roast', 'Roast the vegetables until caramelized', 40, 'none', {
        uses: [oven(425), { appliance: 'air_fryer', tempF: 400, minutesFactor: 0.6 }],
        after: ['chop'],
      }),
    ],
  },

  // ───────────────────────── Mains for other tables ─────────────────────────
  {
    id: 'roast_chicken',
    name: 'Roast chicken',
    aliases: ['chicken', 'roasted chicken', 'whole chicken'],
    course: 'main',
    cuisine: 'American',
    tags: ['sunday', 'gluten-free'],
    servings: 4,
    holdMin: 30,
    tasks: [
      task('prep', 'Season the chicken and get it in the pan', 15, 'full'),
      task('roast', 'Roast the chicken', 75, 'none', { uses: [oven(425, 2)], after: ['prep'] }),
      task('carve', 'Carve the chicken', 10, 'full', {
        after: [{ task: 'roast', minGap: 15, maxGap: 30, gapLabel: 'Chicken rests' }],
      }),
    ],
  },
  {
    id: 'prime_rib',
    name: 'Prime rib roast',
    aliases: ['prime rib', 'standing rib roast', 'rib roast'],
    course: 'main',
    cuisine: 'American',
    tags: ['christmas', 'holiday', 'gluten-free'],
    servings: 8,
    unit: { name: 'pounds', perGuest: 0.75, min: 4, max: 20 },
    holdMin: 20,
    prework: ['Salt the roast and leave it uncovered in the fridge the night before.'],
    tasks: [
      task('prep', 'Bring the roast to room temperature and season it', 30, 'light'),
      task('roast', 'Roast the prime rib', 0, 'none', { perUnit: 16, uses: [oven(325, 2)], after: ['prep'] }),
      task('carve', 'Carve the roast', 10, 'full', {
        after: [{ task: 'roast', minGap: 20, maxGap: 40, gapLabel: 'Roast rests' }],
      }),
    ],
  },
  {
    id: 'ham',
    name: 'Glazed ham',
    aliases: ['ham', 'baked ham'],
    course: 'main',
    cuisine: 'American',
    tags: ['easter', 'christmas', 'holiday'],
    servings: 10,
    unit: { name: 'pounds', perGuest: 0.6, min: 6, max: 20 },
    holdMin: 40,
    tasks: [
      task('prep', 'Score the ham and mix the glaze', 15, 'light'),
      task('bake', 'Bake the ham, glazing near the end', 0, 'none', { perUnit: 12, uses: [oven(325, 2)], after: ['prep'] }),
      task('carve', 'Slice the ham', 10, 'full', { after: [{ task: 'bake', minGap: 20, maxGap: 45, gapLabel: 'Ham rests' }] }),
    ],
  },
  {
    id: 'brisket',
    name: 'Braised brisket',
    aliases: ['brisket', 'beef brisket'],
    course: 'main',
    cuisine: 'Jewish',
    tags: ['hanukkah', 'passover', 'holiday'],
    servings: 8,
    unit: { name: 'pounds', perGuest: 0.75, min: 3, max: 12 },
    holdMin: 45,
    blurb: 'Low and slow. Even better made the day before and reheated.',
    tasks: [
      task('sear', 'Season and sear the brisket, then add the onions and stock', 30, 'full', { uses: [burner], makeAhead: 720 }),
      task('braise', 'Braise the brisket, covered', 60, 'none', { perUnit: 40, uses: [oven(325, 2)], after: ['sear'] }),
      task('slice', 'Slice the brisket against the grain', 15, 'full', {
        after: [{ task: 'braise', minGap: 30, maxGap: 90, gapLabel: 'Brisket rests' }],
      }),
    ],
  },
  {
    id: 'latkes',
    name: 'Potato latkes',
    aliases: ['latkes', 'potato pancakes'],
    course: 'side',
    cuisine: 'Jewish',
    tags: ['hanukkah', 'holiday', 'vegetarian'],
    servings: 8,
    holdMin: 15,
    blurb: 'Best fried right before serving.',
    tasks: [
      task('grate', 'Grate the potatoes and onion and squeeze out the water', 25, 'full', { scales: true }),
      task('fry', 'Fry the latkes in batches', 30, 'full', { uses: [burner], scales: true, after: [{ task: 'grate', maxGap: 15 }] }),
    ],
  },
  {
    id: 'applesauce',
    name: 'Homemade applesauce',
    aliases: ['applesauce'],
    course: 'side',
    cuisine: 'Jewish',
    tags: ['hanukkah', 'holiday', 'vegetarian', 'gluten-free'],
    servings: 8,
    holdMin: 2 * DAY,
    tasks: [
      task('peel', 'Peel and chop the apples', 15, 'full', { makeAhead: 2 * DAY }),
      task('simmer', 'Simmer the apples until soft, then mash', 25, 'light', { uses: [burner], after: [{ task: 'peel', maxGap: 30 }], makeAhead: 2 * DAY }),
    ],
  },
  {
    id: 'biryani',
    name: 'Chicken biryani',
    aliases: ['biryani', 'chicken biryani'],
    course: 'main',
    cuisine: 'South Asian',
    tags: ['eid', 'diwali', 'holiday', 'gluten-free'],
    servings: 8,
    holdMin: 30,
    blurb: 'Marinate, par-boil the rice, layer, then steam on low heat.',
    tasks: [
      task('marinate', 'Marinate the chicken in yogurt and spices', 20, 'full', { scales: true, makeAhead: 720 }),
      task('soak', 'Let the chicken marinate', 120, 'none', { after: ['marinate'], makeAhead: 720 }),
      task('parboil', 'Par-boil the rice with whole spices', 15, 'light', { uses: [burner] }),
      task('layer', 'Layer the chicken and rice in the pot', 15, 'full', {
        after: ['soak', { task: 'parboil', maxGap: 10 }],
      }),
      task('dum', 'Steam the sealed pot on low heat', 40, 'light', { uses: [burner], after: [{ task: 'layer', maxGap: 15 }] }),
    ],
  },
  {
    id: 'raita',
    name: 'Cucumber raita',
    aliases: ['raita'],
    course: 'side',
    cuisine: 'South Asian',
    tags: ['eid', 'diwali', 'vegetarian', 'gluten-free', 'easy'],
    servings: 8,
    holdMin: 720,
    tasks: [task('make', 'Grate the cucumber and stir into spiced yogurt', 10, 'full', { makeAhead: 720 })],
  },
  {
    id: 'dumplings',
    name: 'Steamed dumplings',
    aliases: ['dumplings', 'jiaozi', 'potstickers'],
    course: 'main',
    cuisine: 'Chinese',
    tags: ['lunar-new-year', 'holiday'],
    servings: 8,
    holdMin: 10,
    tasks: [
      task('filling', 'Mix the dumpling filling', 25, 'full', { scales: true, makeAhead: 720 }),
      task('wrap', 'Wrap the dumplings', 45, 'full', { scales: true, after: ['filling'], makeAhead: 720 }),
      task('steam', 'Steam the dumplings in batches', 20, 'light', { uses: [burner], after: [{ task: 'wrap', maxGap: 240 }] }),
    ],
  },
  {
    id: 'rice',
    name: 'Steamed rice',
    aliases: ['rice', 'white rice', 'jasmine rice'],
    course: 'side',
    cuisine: 'Asian',
    tags: ['vegetarian', 'gluten-free', 'easy'],
    servings: 8,
    holdMin: 30,
    tasks: [
      task('rinse', 'Rinse the rice', 5, 'light'),
      task('cook', 'Cook the rice', 20, 'none', { uses: [burner], after: [{ task: 'rinse', maxGap: 30 }] }),
      task('fluff', 'Fluff the rice', 3, 'light', { after: [{ task: 'cook', minGap: 10, maxGap: 30, gapLabel: 'Rice steams off the heat' }] }),
    ],
  },
  {
    id: 'lasagna',
    name: 'Lasagna',
    aliases: ['lasagne'],
    course: 'main',
    cuisine: 'Italian',
    tags: ['sunday'],
    servings: 8,
    holdMin: 30,
    tasks: [
      task('sauce', 'Simmer the meat sauce', 45, 'light', { uses: [burner], makeAhead: DAY }),
      task('assemble', 'Layer the lasagna', 25, 'full', { after: ['sauce'], makeAhead: DAY }),
      task('bake', 'Bake the lasagna', 55, 'none', { uses: [oven(375, 2)], after: ['assemble'] }),
      task('rest', 'Let the lasagna set before cutting', 15, 'none', { after: [{ task: 'bake', minGap: 0, maxGap: 30 }] }),
    ],
  },
];

export const DISH_INDEX: ReadonlyMap<string, DishDef> = new Map(DISHES.map((d) => [d.id, d]));

export interface MenuDef {
  id: string;
  name: string;
  occasion: string;
  dishes: string[];
}

export const MENUS: MenuDef[] = [
  {
    id: 'thanksgiving',
    name: 'Classic Thanksgiving',
    occasion: 'Thanksgiving',
    dishes: ['turkey', 'gravy', 'mashed', 'stuffing', 'green_bean', 'sweet_potatoes', 'cranberry', 'rolls', 'pumpkin_pie'],
  },
  {
    id: 'friendsgiving',
    name: 'Small Friendsgiving',
    occasion: 'Friendsgiving',
    dishes: ['roast_chicken', 'mashed', 'brussels', 'rolls_store', 'apple_pie'],
  },
  {
    id: 'christmas',
    name: 'Christmas prime rib',
    occasion: 'Christmas',
    dishes: ['prime_rib', 'mashed', 'brussels', 'rolls_store', 'salad'],
  },
  {
    id: 'easter',
    name: 'Easter ham dinner',
    occasion: 'Easter',
    dishes: ['ham', 'sweet_potatoes', 'green_bean', 'rolls_store', 'apple_pie'],
  },
  {
    id: 'hanukkah',
    name: 'Hanukkah dinner',
    occasion: 'Hanukkah',
    dishes: ['brisket', 'latkes', 'applesauce', 'salad'],
  },
  {
    id: 'eid',
    name: 'Biryani feast',
    occasion: 'Eid or Diwali',
    dishes: ['biryani', 'raita', 'salad'],
  },
  {
    id: 'lunar_new_year',
    name: 'Lunar New Year dumplings',
    occasion: 'Lunar New Year',
    dishes: ['dumplings', 'rice', 'roasted_veg'],
  },
  {
    id: 'sunday',
    name: 'Sunday dinner',
    occasion: 'Sunday supper',
    dishes: ['roast_chicken', 'roasted_veg', 'mashed', 'garlic_bread'],
  },
];

export const MENU_INDEX: ReadonlyMap<string, MenuDef> = new Map(MENUS.map((m) => [m.id, m]));

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Look up a dish by id, name or alias; also accepts a household's custom dishes. */
export function findDish(query: string, custom: DishDef[] = []): DishDef | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const all = [...custom, ...DISHES];
  return (
    all.find((d) => norm(d.id) === q || norm(d.name) === q) ??
    all.find((d) => (d.aliases ?? []).some((a) => norm(a) === q)) ??
    all.find((d) => norm(d.name).includes(q) || q.includes(norm(d.name))) ??
    all.find((d) => (d.aliases ?? []).some((a) => norm(a).includes(q) || q.includes(norm(a))))
  );
}

export function findMenu(query: string): MenuDef | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return (
    MENUS.find((m) => norm(m.id) === q || norm(m.name) === q || norm(m.occasion) === q) ??
    MENUS.find((m) => norm(m.name).includes(q) || norm(m.occasion).includes(q) || q.includes(norm(m.occasion)))
  );
}

export function searchDishes(query: string, custom: DishDef[] = []): DishDef[] {
  const q = norm(query);
  const all = [...custom, ...DISHES];
  if (!q) return all;
  const words = q.split(' ');
  return all.filter((d) => {
    const hay = norm([d.name, d.cuisine, d.course, d.blurb ?? '', ...(d.aliases ?? []), ...d.tags].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** Default quantity (pounds) for weight-sized dishes. */
export function defaultQuantity(dish: DishDef, guests: number): number | undefined {
  if (!dish.unit) return undefined;
  const q = Math.round(guests * dish.unit.perGuest);
  return Math.min(dish.unit.max, Math.max(dish.unit.min, q));
}
