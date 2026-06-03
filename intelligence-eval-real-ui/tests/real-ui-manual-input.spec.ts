// Real UI: manual question input → real chat stream → grade UI-visible answer.
import { test, expect, FIXTURES, cases } from './_shared.ts';
import { profilePaths, loadProfileThroughUI } from '../helpers/profile-loader-ui.ts';
import { askManualQuestion } from '../helpers/manual-question-ui.ts';
import { UiLatencyRecorder } from '../helpers/latency-recorder-ui.ts';
import { gradeUiAnswer } from '../helpers/accuracy-grader-ui.ts';

const manual = cases.filter(c => c.mode === 'manual_input' && c.profileId === 'backend-engineer').slice(0, 5);

const manualProfileRegression = [
  {
    question: 'what is my name?',
    mustContain: [/Chen Wei/i],
    mustNotContain: [/I don'?t know your name/i, /I'?m Natively/i, /AI assistant/i],
  },
  {
    question: 'what are my experiences?',
    mustContain: [/Amazon/i, /Data Analyst/i, /Zara/i],
    mustNotContain: [/I don'?t have personal experiences/i, /I'?m Natively/i, /AI assistant/i],
  },
  {
    question: 'what all projects have you done?',
    mustContain: [/ABTest-Framework/i, /SQL-Copilot/i],
    mustNotContain: [/I don'?t have.*projects/i, /I'?m Natively/i, /AI assistant/i],
  },
  {
    question: 'what are my skills?',
    mustContain: [/SQL/i, /Python/i, /Tableau/i],
    mustNotContain: [/I'?m Natively/i, /AI assistant/i],
  },
  {
    question: 'what is my education?',
    mustContain: [/UC Berkeley/i, /Statistics/i],
    mustNotContain: [/I'?m Natively/i, /AI assistant/i],
  },
  {
    question: 'what role am I applying for?',
    mustContain: [/Senior Data Analyst/i],
    mustNotContain: [/I'?m Natively/i, /AI assistant/i],
  },
  {
    question: 'who are you?',
    mustContain: [/Natively/i, /AI assistant/i],
    mustNotContain: [/Chen Wei/i, /Amazon/i, /ABTest-Framework/i],
  },
  {
    question: 'what is your name?',
    mustContain: [/Natively/i],
    mustNotContain: [/Chen Wei/i, /Amazon/i, /ABTest-Framework/i],
  },
];

test.describe('real UI — manual input', () => {
  for (const tc of manual) {
    test(`${tc.testId} ${tc.pattern}: ${tc.question}`, async ({ natively }) => {
      const settings = await natively.settingsWindow();
      await loadProfileThroughUI(natively, settings, profilePaths(FIXTURES, tc.profileId));
      const overlay = await natively.overlayWindow().catch(() => settings);
      const rec = new UiLatencyRecorder();
      const r = await askManualQuestion(overlay, tc.question!, rec);
      expect(r.visibleConfirmed, 'answer must be visible in the UI').toBeTruthy();
      const g = gradeUiAnswer(tc, r.text);
      if (!g.passed) console.warn(`${tc.testId} fail:`, g.failReasons, '| answer:', r.text.slice(0, 120));
      expect(g.passed, g.failReasons.join(', ')).toBeTruthy();
    });
  }

  test('MANUAL-PI real UI regression: profile facts beat assistant identity, assistant identity still works', async ({ natively }) => {
    const settings = await natively.settingsWindow();
    await loadProfileThroughUI(natively, settings, profilePaths(FIXTURES, 'data-analyst'));
    await expect
      .poll(async () => {
        try {
          return await settings.evaluate(() => (window as any).electronAPI?.__evalProfileDebug?.());
        } catch {
          return null;
        }
      }, { timeout: 120_000, message: 'profileFactsReady should become true after structured resume extraction' })
      .toMatchObject({ profileFactsReady: true });

    const overlay = await natively.overlayWindow().catch(() => settings);
    for (const tc of manualProfileRegression) {
      const rec = new UiLatencyRecorder();
      const r = await askManualQuestion(overlay, tc.question, rec);
      expect(r.visibleConfirmed, `${tc.question} answer must be visible in the UI`).toBeTruthy();
      for (const pattern of tc.mustContain) expect(r.text, `${tc.question} should contain ${pattern}`).toMatch(pattern);
      for (const pattern of tc.mustNotContain) expect(r.text, `${tc.question} should not contain ${pattern}`).not.toMatch(pattern);
    }
  });
});
