import { expect, test } from "@playwright/test";
import { splitWords, wordAt } from "../lib/words";

test("follow-along uses source timestamps and never highlights only whitespace", () => {
  const tokens = [
    { text: "ส", start: 1.0, end: 1.1 },
    { text: "วัสดี", start: 1.1, end: 1.8 },
    { text: " ", start: 1.8, end: 2.0 },
    { text: "ครับ", start: 3.5, end: 4.0 },
  ];
  const words = splitWords("สวัสดี ครับ", tokens);

  expect(words.map((word) => word.t).join("")).toBe("สวัสดี ครับ");
  expect(words.every((word) => word.t.trim().length > 0)).toBe(true);
  expect(wordAt(words, 1.2, 1, 4)).toBe(0);
  expect(wordAt(words, 3.6, 1, 4)).toBe(1);
});

test("follow-along falls back to a length estimate when edited text no longer matches", () => {
  const words = splitWords("สวัสดีทุกคน", [{ text: "ข้อความเดิม", start: 1, end: 2 }]);

  expect(words.every((word) => word.start === undefined)).toBe(true);
  expect(wordAt(words, 1, 1, 5)).toBe(0);
  expect(wordAt(words, 4.99, 1, 5)).toBe(words.length - 1);
});
