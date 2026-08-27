#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'content/image-questions/curated-commons.json');
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
const endpoint = 'https://en.wikipedia.org/w/api.php';
const userAgent = 'FatinahImageCatalog/1.3 (https://ata20.com)';

// قائمة مقصودة لأشياء يومية واضحة؛ العنوان الإنكليزي يحدد صفحة ويكيبيديا بدقة،
// والاسم العربي مكتوب للعبة يدوياً حتى لا نعتمد على ترجمة آلية غامضة.
const definitions = [
  ['Bicycle','دراجة هوائية'],['Motorcycle','دراجة نارية'],['Car','سيارة'],['Bus','حافلة'],
  ['Truck','شاحنة'],['Train','قطار'],['Airplane','طائرة'],['Helicopter','مروحية'],
  ['Ship','سفينة'],['Sailboat','قارب شراعي'],['Canoe','زورق كانو'],['Kayak','قارب كاياك'],
  ['Tractor','جرار زراعي'],['Ambulance','سيارة إسعاف'],['Fire engine','سيارة إطفاء'],['Wheelbarrow','عربة يد'],
  ['Skateboard','لوح تزلج'],['Kick scooter','سكوتر'],['Roller skates','حذاء تزلج'],['Hot-air balloon','منطاد'],
  ['Camera','كاميرا'],['Binoculars','منظار'],['Telescope','مقراب'],['Microscope','مجهر'],
  ['Compass','بوصلة'],['Clock','ساعة حائط'],['Alarm clock','ساعة منبّه'],['Wristwatch','ساعة يد'],
  ['Hourglass','ساعة رملية'],['Thermometer','مقياس حرارة'],['Barometer','مقياس ضغط جوي'],['Weighing scale','ميزان'],
  ['Calculator','آلة حاسبة'],['Abacus','معداد'],['Laptop','حاسوب محمول'],['Desktop computer','حاسوب مكتبي'],
  ['Computer keyboard','لوحة مفاتيح'],['Computer mouse','فأرة حاسوب'],['Printer (computing)','طابعة'],['Image scanner','ماسح ضوئي'],
  ['Telephone','هاتف'],['Radio','مذياع'],['Television set','تلفاز'],['Loudspeaker','مكبر صوت'],
  ['Headphones','سماعات رأس'],['Microphone','ميكروفون'],['Remote control','جهاز تحكم'],['Flashlight','مصباح يدوي'],
  ['Incandescent light bulb','مصباح كهربائي'],['Fan (machine)','مروحة'],['Hammer','مطرقة'],['Screwdriver','مفك براغي'],
  ['Wrench','مفتاح ربط'],['Pliers','كماشة'],['Hand saw','منشار يدوي'],['Drill','مثقاب'],
  ['Axe','فأس'],['Shovel','مجرفة'],['Rake (tool)','مشط زراعي'],['Hoe (tool)','معول زراعي'],
  ['Ladder','سلّم'],['Rope','حبل'],['Chain','سلسلة'],['Padlock','قفل'],
  ['Key (lock)','مفتاح'],['Scissors','مقص'],['Sewing needle','إبرة خياطة'],['Sewing machine','آلة خياطة'],
  ['Zipper','سحّاب'],['Stapler','دبّاسة'],['Tape measure','شريط قياس'],['Spirit level','ميزان ماء'],
  ['Chair','كرسي'],['Table (furniture)','طاولة'],['Bed','سرير'],['Couch','أريكة'],
  ['Wardrobe','خزانة ملابس'],['Bookcase','خزانة كتب'],['Mirror','مرآة'],['Carpet','سجادة'],
  ['Pillow','وسادة'],['Umbrella','مظلة'],['Suitcase','حقيبة سفر'],['Backpack','حقيبة ظهر'],
  ['Basket','سلّة'],['Bucket','دلو'],['Broom','مكنسة'],['Mop','ممسحة'],
  ['Plate (dishware)','صحن'],['Bowl','وعاء'],['Cup','كوب'],['Drinking glass','كأس زجاجي'],
  ['Bottle','زجاجة'],['Spoon','ملعقة'],['Fork','شوكة'],['Kitchen knife','سكين مطبخ'],
  ['Kettle','غلاية'],['Teapot','إبريق شاي'],['Frying pan','مقلاة'],['Cooking pot','قدر طبخ'],
  ['Whisk','مخفقة'],['Rolling pin','شوبك'],['Toaster','محمصة خبز'],['Microwave oven','فرن ميكروويف'],
  ['Refrigerator','ثلاجة'],['Blender','خلّاط'],['Violin','كمان'],['Guitar','غيتار'],
  ['Oud','عود'],['Piano','بيانو'],['Trumpet','بوق'],['Flute','ناي'],
  ['Drum','طبل'],['Tambourine','دف'],['Saxophone','ساكسفون'],['Accordion','أكورديون'],
  ['Harp','قيثارة'],['Association football ball','كرة قدم'],['Basketball (ball)','كرة سلة'],['Tennis racket','مضرب تنس'],
  ['Golf club','عصا غولف'],['Bowling ball','كرة بولينغ'],['Dumbbell','ثقل يدوي'],['Chessboard','رقعة شطرنج'],
  ['Dice','حجر نرد'],['Helmet','خوذة'],['Shoe','حذاء'],['Boot','جزمة'],
  ['Hat','قبعة'],['Sunglasses','نظارة شمسية'],['Glove','قفاز'],['Belt (clothing)','حزام'],
  ['Wallet','محفظة'],['Ring (jewellery)','خاتم'],['Necklace','قلادة'],['Toothbrush','فرشاة أسنان'],
  ['Comb','مشط'],['Hair dryer','مجفف شعر'],['Soap','صابونة'],['Razor','شفرة حلاقة'],
  ['Book','كتاب'],['Pencil','قلم رصاص'],['Pen','قلم حبر'],['Eraser','ممحاة'],
  ['Ruler','مسطرة'],['Globe','كرة أرضية'],['Map','خريطة'],['Envelope','ظرف بريدي'],
  ['Postage stamp','طابع بريدي'],['Fire extinguisher','مطفأة حريق'],['Traffic light','إشارة مرور'],['Stop sign','علامة قف'],
  ['Fire hydrant','صنبور إطفاء'],['Anchor','مرساة'],['Wheel','عجلة'],['Gear','ترس'],
  ['Electric battery','بطارية'],['Magnet','مغناطيس'],['Coil spring','نابض'],['Pulley','بكرة'],
  ['Propeller','مروحة دافعة'],['Lifejacket','سترة نجاة'],['Parachute','مظلة هبوط'],['Tent','خيمة'],
  ['Sleeping bag','كيس نوم'],['Lantern','فانوس'],['Candle','شمعة'],['Match','عود ثقاب'],
  ['Paintbrush','فرشاة رسم'],['Paint roller','أسطوانة طلاء'],['Fountain pen','قلم حبر سائل'],['Magnifying glass','عدسة مكبرة'],
  ['Stethoscope','سماعة طبيب'],['Syringe','حقنة'],['Wheelchair','كرسي متحرك'],['Crutch','عكاز'],
  ['Safety pin','دبوس أمان'],['Paper clip','مشبك ورق'],['Binder clip','مشبك ملفات'],['Clothes hanger','علّاقة ملابس'],
  ['Clothespin','ملقط غسيل'],['Iron (device)','مكواة'],['Vacuum cleaner','مكنسة كهربائية'],['Washing machine','غسالة'],
  ['Dishwasher','غسالة صحون'],['Oven','فرن'],['Gas stove','موقد غاز'],['Coffee grinder','مطحنة قهوة'],
  ['Mortar and pestle','هاون ومدقة'],['Colander','مصفاة'],['Corkscrew','فتاحة فلين'],['Can opener','فتاحة علب'],
];

async function fetchBatch(batch) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({
    action: 'query', format: 'json', redirects: '1', prop: 'pageimages|pageprops',
    piprop: 'original', ppprop: 'wikibase_item', titles: batch.map(item => item[0]).join('|'),
  })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
  return response.json();
}

const rows = [];
for (let index = 0; index < definitions.length; index += 40) {
  const batch = definitions.slice(index, index + 40);
  const payload = await fetchBatch(batch);
  const pages = Object.values(payload.query?.pages || {});
  const byTitle = new Map(pages.map(page => [page.title, page]));
  const normalized = new Map((payload.query?.normalized || []).map(item => [item.from, item.to]));
  const redirects = new Map((payload.query?.redirects || []).map(item => [item.from, item.to]));
  for (const [title, answer] of batch) {
    const resolved = redirects.get(normalized.get(title) || title) || normalized.get(title) || title;
    const page = byTitle.get(resolved);
    const itemId = page?.pageprops?.wikibase_item;
    const source = page?.original?.source;
    if (!/^Q\d+$/.test(itemId || '') || !source) continue;
    const file = decodeURIComponent(new URL(source).pathname.split('/').pop()).replace(/_/g, ' ');
    rows.push({ itemId, answer, file });
  }
}

const unique = [];
const seen = new Set();
for (const row of rows) if (!seen.has(row.itemId)) { seen.add(row.itemId); unique.push(row); }
if (unique.length < 143) throw new Error(`المرشحون الواضحون ${unique.length}/143 فقط`);

const category = catalog.categories.find(item => item.name === 'شنو هالشي؟');
const base = category.items.slice(0, 12);
category.target = 125;
category.items = [...base, ...unique.map((row, index) => ({
  id: `objectx-${row.itemId.toLowerCase()}`,
  difficulty: Math.min(6, 1 + Math.floor(index / 24)),
  answer: row.answer,
  file: row.file,
  alt: 'صورة واضحة لشيء يومي ملموس، مع إبقاء اسمه مخفياً أثناء السؤال',
  factUrl: `https://www.wikidata.org/wiki/${row.itemId}`,
}))];
catalog.version = 5;
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`✓ شنو هالشي؟: ${base.length} أساسية + ${unique.length} مرشحاً يومياً واضحاً`);
