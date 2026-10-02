/* Single source of truth for the rule-based router.
 * Loaded by the browser (js/shared.js) AND parsed by tools/evaluate.py,
 * so the demo and the evaluator can never drift apart.
 * Keep this file strict JSON after the "const NC_MODEL = " prefix. */
const NC_MODEL = {
  "version": "rule-based-v1.3-context",
  "threshold": 0.32,
  "keywordWeight": 1,
  "phraseWeight": 2.2,
  "contextCarryover": 0.6,
  "contextWindow": 4,
  "shortMessageMaxWords": 7,
  "confidence": {"shareWeight": 0.45, "evidenceWeight": 0.55, "evidenceScale": 2.2, "max": 0.98},
  "intents": {
    "internship": {"label": "Internship", "keywords": ["internship","intern","apply","application","interview","recruiter","visa","sponsorship","japan","company"], "phrases": ["summer internship","internship in japan","technical interview"]},
    "technical":  {"label": "Technical",  "keywords": ["api","python","react","typescript","fastapi","docker","database","architecture","algorithm","bug","deploy","model","transformer","layernorm"], "phrases": ["how does it work","system design","rest api"]},
    "project":    {"label": "Project",    "keywords": ["project","build","prototype","portfolio","app","scope","ship","mvp"], "phrases": ["project idea","side project","portfolio project"]},
    "resume":     {"label": "Resume",     "keywords": ["resume","cv","bullet","portfolio","cover","letter"], "phrases": ["resume bullet","cover letter","review my resume"]},
    "study":      {"label": "Study",      "keywords": ["study","learn","exam","revision","schedule","plan","practice","jlpt"], "phrases": ["study plan","learning path","prepare for exam"]},
    "greeting":   {"label": "Greeting",   "keywords": ["hi","hello","hey","morning","evening"], "phrases": ["good morning","how are you"]}
  },
  "entities": {
    "technology": ["react","typescript","python","fastapi","docker","aws","pytorch","llm","nlp"],
    "role": ["internship","software engineer","ml engineer"],
    "location": ["japan","tokyo","india","bangalore","remote"],
    "organisation": ["oist","sony","google","amazon","microsoft"],
    "language": ["japanese","english","jlpt"]
  }
};
if (typeof module !== 'undefined') module.exports = NC_MODEL;
