import { gradeUiAnswer } from './helpers/accuracy-grader-ui.ts';
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m));};

// Bug1: "$" forbidden must NOT false-positive on a clean identity answer
const b1 = gradeUiAnswer(
  {testId:'t',profileId:'p',mode:'what_to_answer',pattern:'context_isolation',transcript:'Interviewer: What is your name?',expectedPerspective:'first_person',requiredFacts:['Aarav Menon'],forbiddenFacts:["I'm Natively",'salary','$'],expectedLayers:[],excludedLayers:[]},
  "I'm Aarav Menon, interviewing for the senior backend engineering role."
);
console.log('Bug1 — clean identity answer not flagged for $/salary:');
ok(b1.passed===true, `passed=${b1.passed} reasons=${JSON.stringify(b1.failReasons)}`);

// Bug5: deferring salary (interviewer raised it) is NOT a leak; real $ figure IS
console.log('Bug5 — salary deferral OK, real figure leaks:');
const defer = gradeUiAnswer(
  {testId:'t',profileId:'p',mode:'what_to_answer',pattern:'context_isolation',transcript:'Interviewer: What is your name?\nInterviewer: Also we will discuss salary later.',expectedPerspective:'first_person',requiredFacts:['Priya Sharma'],forbiddenFacts:['salary','$'],expectedLayers:[],excludedLayers:[]},
  "I'm Priya Sharma. That works for me, we can park the salary discussion for later."
);
ok(defer.passed===true, `deferral passed=${defer.passed} reasons=${JSON.stringify(defer.failReasons)}`);
const leak = gradeUiAnswer(
  {testId:'t',profileId:'p',mode:'what_to_answer',pattern:'context_isolation',transcript:'Interviewer: What is your name?',expectedPerspective:'first_person',requiredFacts:['Priya Sharma'],forbiddenFacts:['salary','$'],expectedLayers:[],excludedLayers:[]},
  "I'm Priya Sharma. I'm looking for $180,000 base salary."
);
ok(leak.passed===false && leak.failReasons.some(f=>f.includes('$')||f.includes('salary')), `real leak should fail: passed=${leak.passed} reasons=${JSON.stringify(leak.failReasons)}`);

// Bug3: follow_up answer that engages the question (no literal topic echo) passes
console.log('Bug3 — on-topic follow_up without topic echo passes:');
const fu = gradeUiAnswer(
  {testId:'t',profileId:'p',mode:'what_to_answer',pattern:'follow_up',transcript:'Interviewer: Tell me about your API gateway project.\nCandidate: It handled auth.\nInterviewer: How did you improve latency in that project?',expectedPerspective:'first_person',requiredFacts:[],forbiddenFacts:[],expectedLayers:[],excludedLayers:[],isFollowUp:true,followUpTarget:'gateway'},
  "I cut latency by caching authenticated session tokens in Redis to avoid DB round-trips, and added connection pooling on the routing layer to reduce tail latency."
);
ok(fu.passed===true, `follow_up engaged passed=${fu.passed} reasons=${JSON.stringify(fu.failReasons)}`);
// follow_up that is a pure deflection should fail
const dud = gradeUiAnswer(
  {testId:'t',profileId:'p',mode:'what_to_answer',pattern:'follow_up',transcript:'Interviewer: Tell me about your API gateway project.\nInterviewer: How did you improve latency?',expectedPerspective:'first_person',requiredFacts:[],forbiddenFacts:[],expectedLayers:[],excludedLayers:[],isFollowUp:true,followUpTarget:'gateway'},
  "I can't help."
);
ok(dud.passed===false, `pure deflection should fail: passed=${dud.passed}`);

console.log(`\nGRADER UNITS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
