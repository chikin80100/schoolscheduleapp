/**
 * メモの保存形式の正規化を検証する。
 *
 *   node tools/test-notes.mjs
 */

import assert from 'node:assert/strict';
import { MAX_NOTES, MAX_NOTE_LENGTH, emptyState, normalizeState, sortedNotes } from '../public/js/timetable.js';

// メモの無い古い保存データでも、空の一覧として読める
assert.deepEqual(emptyState().notes, []);
assert.deepEqual(normalizeState({}).notes, []);
assert.deepEqual(normalizeState({ notes: 'broken' }).notes, []);

// 中身が空のもの・形の崩れたものは捨て、ID の重複は先勝ち
const notes = normalizeState({
  notes: [
    { id: 'a', body: '持ち物\n体操服', createdAt: 1, updatedAt: 10 },
    { id: 'b', body: '   \n ', updatedAt: 20 },
    { id: 'c', body: 42 },
    null,
    { id: 'a', body: '重複', updatedAt: 30 },
    { id: 'd', body: 'テスト範囲', updatedAt: 5 },
  ],
}).notes;
assert.deepEqual(notes.map((note) => note.id), ['a', 'd']);
assert.equal(notes[0].body, '持ち物\n体操服');

// 時刻が無いものは 0 として扱い、ID が無ければ振る
const [loose] = normalizeState({ notes: [{ body: 'メモ' }] }).notes;
assert.equal(loose.updatedAt, 0);
assert.equal(typeof loose.id, 'string');
assert.ok(loose.id.length > 0);

// 長すぎる本文は切り詰める
const [long] = normalizeState({ notes: [{ id: 'x', body: 'あ'.repeat(MAX_NOTE_LENGTH + 5) }] }).notes;
assert.equal(long.body.length, MAX_NOTE_LENGTH);

// 上限を超えたら、古いものから落とす
const many = Array.from({ length: MAX_NOTES + 3 }, (_, i) => ({ id: `n${i}`, body: `${i}`, updatedAt: i + 1 }));
const kept = normalizeState({ notes: many }).notes;
assert.equal(kept.length, MAX_NOTES);
assert.ok(!kept.some((note) => ['n0', 'n1', 'n2'].includes(note.id)));

// 一覧は新しく更新した順
const state = { notes: [{ id: 'old', body: '1', updatedAt: 1 }, { id: 'new', body: '2', updatedAt: 9 }] };
assert.deepEqual(sortedNotes(state).map((note) => note.id), ['new', 'old']);

console.log('メモのテストに合格しました');
