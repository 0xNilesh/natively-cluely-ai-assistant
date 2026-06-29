// Tests for the Document Map (round-6 rebuild, 2026-06-29).
//
// buildDocumentMap parses + excludes the Table of Contents, detects real
// section headings (not ToC lines, not table rows, not bibliography), and
// returns a section tree with page ranges. resolveTargetSections maps a
// question to target section numbers from the section titles.
//
// These are BEHAVIOURAL tests against the compiled module — they exercise the
// real parser, not a source grep. They encode the exact failures round 6
// found on the real thesis PDF: ToC dotted-leader lines must NOT become
// sections; chapter numbers >12 must be detected; bibliography lines and prose
// ending in a number must NOT be mistaken for headings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

async function loadMap() {
  const p = path.resolve(repoRoot, 'dist-electron/electron/services/modes/DocumentMap.js');
  return import(pathToFileURL(p).href);
}

// A miniature thesis with a ToC + real sections + the failure modes.
const THESIS = [
  '[Page 1]',
  'Towards Connected Intelligence',
  'Master Thesis 2025',
  '[Page 5]',
  'Contents',
  '1 Introduction . . . . . . . . . . . . . . . . . . . . 7',
  '1.1 Research Questions . . . . . . . . . . . . . . . 8',
  '2.1.2 OpenVLA-OFT . . . . . . . . . . . . . . . . . 13',
  '2.4.2 ROS# . . . . . . . . . . . . . . . . . . . . . 20',
  '4.1 Evaluation metrics . . . . . . . . . . . . . . . 44',
  '[Page 7]',
  '1 Introduction',
  'This thesis studies Agentic AI frameworks with Vision-Language-Action models for embodied robotic systems.',
  '[Page 8]',
  '1.1 Research Questions',
  'RQ1: Can an Agentic AI Framework be combined with a Vision-Language-Action Model towards achieving AGI?',
  'RQ2: Can a network of AI Agents improve perception and decision-making of autonomous robots?',
  '[Page 13]',
  '2.1.2 OpenVLA-OFT',
  'OpenVLA-OFT is an improved version of OpenVLA that uses parallel decoding and action chunking and achieves 43x faster throughput.',
  '[Page 20]',
  '2.4.2 ROS#',
  'ROS# is a set of open-source C# libraries for communicating with ROS from .NET applications, in particular Unity.',
  '[Page 44]',
  '4.1 Evaluation metrics',
  'Success Rate and MSE were used as the primary evaluation metrics.',
].join('\n');

test('buildDocumentMap excludes the ToC and detects real sections', async () => {
  const { buildDocumentMap } = await loadMap();
  const map = buildDocumentMap(THESIS);
  assert.equal(map.hasToc, true, 'a thesis with dotted-leader ToC must set hasToc');
  assert.ok(map.tocLinesRemoved >= 5, `expected >=5 ToC lines removed, got ${map.tocLinesRemoved}`);
  const nums = map.sections.filter(s => s.num).map(s => s.num);
  assert.ok(nums.includes('1.1'), 'Research Questions section detected');
  assert.ok(nums.includes('2.1.2'), 'OpenVLA-OFT section detected');
  assert.ok(nums.includes('2.4.2'), 'ROS# section detected');
  assert.ok(nums.includes('4.1'), 'Evaluation metrics section detected');
});

test('ToC dotted-leader lines never become section bodies', async () => {
  const { buildDocumentMap } = await loadMap();
  const map = buildDocumentMap(THESIS);
  // The OpenVLA-OFT section body must be the REAL body, not the ToC line.
  const oft = map.sections.find(s => s.num === '2.1.2');
  assert.ok(oft, 'OpenVLA-OFT section exists');
  assert.match(oft.body, /parallel decoding|action chunking|43x/, 'body is the real section, not the ToC entry');
  assert.doesNotMatch(oft.body, /\.\s?\.\s?\.\s?\./, 'body must not contain ToC dotted leaders');
});

test('section bodies carry correct page ranges', async () => {
  const { buildDocumentMap } = await loadMap();
  const map = buildDocumentMap(THESIS);
  const rq = map.sections.find(s => s.num === '1.1');
  assert.equal(rq.pageStart, 8, 'Research Questions starts on page 8');
  const oft = map.sections.find(s => s.num === '2.1.2');
  assert.equal(oft.pageStart, 13, 'OpenVLA-OFT starts on page 13');
});

test('chapter numbers >12 are detected (no firstNum<=12 cap)', async () => {
  const { buildDocumentMap } = await loadMap();
  const map = buildDocumentMap('[Page 1]\n13 Future Work\nFuture directions.\n13.2 Limitations\nSeveral limitations exist.');
  const nums = map.sections.filter(s => s.num).map(s => s.num);
  assert.ok(nums.includes('13'), 'chapter 13 detected');
  assert.ok(nums.includes('13.2'), 'section 13.2 detected');
});

test('bibliography lines are NOT mistaken for headings', async () => {
  const { buildDocumentMap } = await loadMap();
  const map = buildDocumentMap('[Page 60]\n12 Smith et al 2021 Robotics survey\nsome reference text\n5 Doe and Roe 2019 Vision models');
  const nums = map.sections.filter(s => s.num).map(s => s.num);
  assert.equal(nums.length, 0, `bibliography lines must not become headings, got [${nums.join(',')}]`);
});

test('real headings with "pose" or a year survive (review HIGH fixes)', async () => {
  const { buildDocumentMap } = await loadMap();
  // "Pose Estimation" was dropped by an unbounded `pose` substring guard.
  const poseMap = buildDocumentMap('[Page 1]\n3.2 Pose Estimation\nWe estimate the 6-DOF pose of the gripper.');
  assert.ok(poseMap.sections.some(s => s.num === '3.2'), '"3.2 Pose Estimation" must be a section');
  // A pose DATA row (brackets/coords) must still be rejected.
  const poseRow = buildDocumentMap('[Page 1]\n24 Right arm pose [x, y, z, rx]\ndata');
  assert.ok(!poseRow.sections.some(s => s.num === '24'), 'pose data rows must not become sections');
  // Headings containing a year were dropped by a bare-year bibliography guard.
  const yearMap = buildDocumentMap('[Page 1]\n3.1 The 2020 Dataset\nWe used it.\n2.4 ImageNet-2012 Pretraining\nWe pretrain.');
  assert.ok(yearMap.sections.some(s => s.num === '3.1'), '"3.1 The 2020 Dataset" must survive');
  assert.ok(yearMap.sections.some(s => s.num === '2.4'), '"2.4 ImageNet-2012 Pretraining" must survive');
});

test('sectionAwareChunksFromMap excludes ToC and tags sections (shared chunker)', async () => {
  const { buildDocumentMap, sectionAwareChunksFromMap } = await loadMap();
  const map = buildDocumentMap(THESIS);
  const chunks = sectionAwareChunksFromMap(map, 140, 30);
  assert.ok(Array.isArray(chunks) && chunks.length > 0, 'structured doc must yield section chunks');
  assert.equal(
    chunks.filter(c => /\.\s?\.\s?\.\s?\./.test(c)).length, 0,
    'no chunk may contain ToC dotted leaders (this is what the hybrid path regressed on)',
  );
  assert.ok(chunks.every(c => /^\[(Section [\d.]+|p\d)/.test(c)), 'every chunk carries a [Section|p] provenance tag');
  // A flat-prose doc (no ToC) returns null so the caller keeps its word chunker.
  const flat = buildDocumentMap('Mercury X1 has 19 DOF. Sensors include LiDAR.');
  assert.equal(sectionAwareChunksFromMap(flat, 140, 30), null, 'flat prose → null (no section chunking)');
});

test('prose ending in a number is NOT dropped as a ToC line', async () => {
  const { buildDocumentMap } = await loadMap();
  // No ToC region here → the "N.N Title <page>" rule must not fire.
  const map = buildDocumentMap('[Page 2]\nThe Mercury X1 Robot has 19 degrees of freedom\nIt uses LiDAR and ultrasonic sensors');
  // Content must survive (be in some section body).
  const allBody = map.sections.map(s => s.body).join(' ');
  assert.match(allBody, /19 degrees of freedom/, 'prose ending in a number must survive');
  assert.match(allBody, /LiDAR and ultrasonic/, 'sensor prose must survive');
});

test('flat-prose doc with no ToC does NOT set hasToc', async () => {
  const { buildDocumentMap } = await loadMap();
  // The seminar fixtures are flat prose — no dotted ToC. hasToc must be false so
  // the retriever keeps the existing fineChunk path (no regression).
  const map = buildDocumentMap('Mercury X1 has 19 degrees of freedom. Sensors include LiDAR, ultrasonic, and 2D vision. OpenVLA-OFT uses parallel decoding.');
  assert.equal(map.hasToc, false, 'flat prose with no ToC must not trigger section-chunking');
});

test('resolveTargetSections maps questions to the right sections', async () => {
  const { buildDocumentMap, resolveTargetSections } = await loadMap();
  const map = buildDocumentMap(THESIS);
  assert.deepEqual(
    resolveTargetSections('What is OpenVLA-OFT?', map).slice(0, 1),
    ['2.1.2'],
    'OpenVLA-OFT question targets §2.1.2',
  );
  assert.ok(
    resolveTargetSections('What is the role of ROS#?', map).includes('2.4.2'),
    'ROS# question targets §2.4.2',
  );
  assert.ok(
    resolveTargetSections('What evaluation metrics were used?', map).includes('4.1'),
    'metrics question targets §4.1',
  );
  assert.ok(
    resolveTargetSections('What are the two research questions?', map).includes('1.1'),
    'research questions target §1.1',
  );
});

test('resolveTargetSections returns empty for an unmatched query (global fallback)', async () => {
  const { buildDocumentMap, resolveTargetSections } = await loadMap();
  const map = buildDocumentMap(THESIS);
  const targets = resolveTargetSections('xyzzy plugh nonsense', map);
  assert.equal(targets.length, 0, 'no confident section match → empty → caller falls back to global');
});
