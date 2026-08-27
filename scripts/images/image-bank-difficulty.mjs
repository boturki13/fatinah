const runtimeTargets = new Map([[1, 21], [2, 21], [3, 21], [4, 21], [5, 21], [6, 20]]);
const originalImageBaseDifficulties = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6];

export function rebalanceImageBankDifficulty(bank) {
  for (const [category, questions] of Object.entries(bank)) {
    const hasSeparateOriginalBase = category === 'تعرف على الصورة';
    const expectedCount = hasSeparateOriginalBase ? 113 : 125;
    if (!Array.isArray(questions) || questions.length !== expectedCount) {
      throw new Error(`${category}: عدد Commons غير متوقع ${questions?.length ?? 0}/${expectedCount}`);
    }
    const fixedDifficulties = hasSeparateOriginalBase
      ? originalImageBaseDifficulties
      : questions.slice(0, 12).map(question => Number(question.d));
    const additions = hasSeparateOriginalBase ? questions : questions.slice(12);
    const remaining = new Map(runtimeTargets);
    for (const difficulty of fixedDifficulties) {
      if (!remaining.has(difficulty)) throw new Error(`${category}: مستوى أساسي غير صالح ${difficulty}`);
      remaining.set(difficulty, remaining.get(difficulty) - 1);
    }
    let index = 0;
    for (let difficulty = 1; difficulty <= 6; difficulty += 1) {
      const count = remaining.get(difficulty);
      if (!Number.isInteger(count) || count < 0) throw new Error(`${category}: توزيع المستوى ${difficulty} غير صالح.`);
      for (let offset = 0; offset < count; offset += 1) additions[index++].d = difficulty;
    }
    if (index !== additions.length) {
      throw new Error(`${category}: تعذر موازنة ${additions.length} سؤالاً.`);
    }
  }
}
