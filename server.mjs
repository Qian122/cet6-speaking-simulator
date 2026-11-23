import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";

const app = express();
const port = Number(process.env.PORT || 5176);
const demoMode = process.env.DEMO_MODE === "true";
const hasApiKey = Boolean(process.env.DEEPSEEK_API_KEY);
const textModel = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const baseURL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const deepseek = hasApiKey ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL }) : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const examSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    theme: { type: "string" },
    part1: {
      type: "object",
      additionalProperties: false,
      properties: {
        introPrompt: { type: "string" },
        questions: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
      },
      required: ["introPrompt", "questions"],
    },
    part2: {
      type: "object",
      additionalProperties: false,
      properties: {
        statementPrompt: { type: "string" },
        keyPoints: { type: "array", minItems: 3, maxItems: 4, items: { type: "string" } },
        discussionOpening: { type: "string" },
      },
      required: ["statementPrompt", "keyPoints", "discussionOpening"],
    },
    part3: {
      type: "object",
      additionalProperties: false,
      properties: {
        questions: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } },
      },
      required: ["questions"],
    },
  },
  required: ["title", "theme", "part1", "part2", "part3"],
};

const part1QuestionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
  },
  required: ["questions"],
};

const templateAnswerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    opinion: { type: "string" },
    reason1: { type: "string" },
    example1: { type: "string" },
    reason2: { type: "string" },
    example2: { type: "string" },
    conclusion: { type: "string" },
    fullAnswer: { type: "string" },
    estimatedSeconds: { type: "number", minimum: 1, maximum: 180 },
  },
  required: ["opinion", "reason1", "example1", "reason2", "example2", "conclusion", "fullAnswer", "estimatedSeconds"],
};

const answerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    accuracyRange: { type: "number", minimum: 0, maximum: 5 },
    coherence: { type: "number", minimum: 0, maximum: 5 },
    flexibility: { type: "number", minimum: 0, maximum: 5 },
    pronunciation: { type: "number", minimum: 0, maximum: 5 },
    relevance: { type: "number", minimum: 0, maximum: 5 },
    summary: { type: "string" },
    evidence: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
    corrections: { type: "array", minItems: 0, maxItems: 4, items: { type: "string" } },
    nextStep: { type: "string" },
    optimizedAnswer: templateAnswerSchema,
    standardAnswer: templateAnswerSchema,
  },
  required: ["accuracyRange", "coherence", "flexibility", "pronunciation", "relevance", "summary", "evidence", "corrections", "nextStep", "optimizedAnswer", "standardAnswer"],
};

const finalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    accuracyRange: { type: "number", minimum: 0, maximum: 5 },
    coherence: { type: "number", minimum: 0, maximum: 5 },
    flexibility: { type: "number", minimum: 0, maximum: 5 },
    total: { type: "number", minimum: 0, maximum: 15 },
    level: { type: "string", enum: ["优秀", "良好", "合格", "未达合格"] },
    verdict: { type: "string" },
    strengths: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    weaknesses: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    actionPlan: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } },
    sectionReviews: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          section: { type: "string" },
          comment: { type: "string" },
        },
        required: ["section", "comment"],
      },
    },
  },
  required: ["accuracyRange", "coherence", "flexibility", "total", "level", "verdict", "strengths", "weaknesses", "actionPlan", "sectionReviews"],
};

const answerChineseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    corrections: { type: "array", items: { type: "string" } },
    nextStep: { type: "string" },
  },
  required: ["summary", "evidence", "corrections", "nextStep"],
};

const finalChineseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    actionPlan: { type: "array", items: { type: "string" } },
    sectionReviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { section: { type: "string" }, comment: { type: "string" } },
        required: ["section", "comment"],
      },
    },
  },
  required: ["verdict", "strengths", "weaknesses", "actionPlan", "sectionReviews"],
};

function gradeFromFive(score) {
  if (score >= 4.75) return "A+";
  if (score >= 4.5) return "A";
  if (score >= 4.25) return "A-";
  if (score >= 4) return "B+";
  if (score >= 3.75) return "B";
  if (score >= 3.5) return "B-";
  if (score >= 3.25) return "C+";
  if (score >= 3) return "C";
  if (score >= 2.75) return "C-";
  if (score >= 2.5) return "D+";
  if (score >= 2) return "D";
  return "D-";
}

function gradeFromTotal(total) {
  return gradeFromFive(total / 3);
}

function isQualifiedGrade(grade) {
  return ["A+", "A", "A-", "B+", "B", "B-", "C+", "C"].includes(grade);
}

function needsChinese(values) {
  const text = values.flat(Infinity).map((value) => typeof value === "object" ? JSON.stringify(value) : String(value || "")).join(" ");
  const chineseCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  return latinCount > 30 && chineseCount < Math.max(8, latinCount * 0.12);
}

async function ensureAnswerChinese(analysis) {
  const fields = [analysis.summary, analysis.evidence, analysis.corrections, analysis.nextStep];
  if (!needsChinese(fields)) return analysis;
  try {
    const translated = await structuredResponse({
      name: "answer_feedback_chinese",
      schema: answerChineseSchema,
      instructions: "Translate the supplied CET-SET6 feedback into concise, natural Simplified Chinese. Preserve short quoted English words or corrected example sentences only when necessary. Do not translate or modify any field not supplied.",
      input: JSON.stringify({ summary: analysis.summary, evidence: analysis.evidence, corrections: analysis.corrections, nextStep: analysis.nextStep }),
    });
    return { ...analysis, ...translated };
  } catch {
    return analysis;
  }
}

async function ensureFinalChinese(result) {
  const fields = [result.verdict, result.strengths, result.weaknesses, result.actionPlan, result.sectionReviews];
  if (!needsChinese(fields)) return result;
  try {
    const translated = await structuredResponse({
      name: "final_feedback_chinese",
      schema: finalChineseSchema,
      instructions: "Translate the supplied CET-SET6 overall assessment into concise, natural Simplified Chinese. Keep Part 1, Part 2 and Part 3 section labels if present. Preserve short quoted English evidence only when necessary.",
      input: JSON.stringify({ verdict: result.verdict, strengths: result.strengths, weaknesses: result.weaknesses, actionPlan: result.actionPlan, sectionReviews: result.sectionReviews }),
    });
    return { ...result, ...translated };
  } catch {
    return result;
  }
}

const part1CategoryPool = [
  "study methods and learning habits",
  "academic challenges and course choices",
  "campus facilities and university services",
  "dormitory life, roommates and independent living",
  "food choices, cooking and healthy eating",
  "exercise, sleep, stress and personal health",
  "transportation and daily commuting",
  "digital devices, useful apps and online habits",
  "environmental responsibility in daily life",
  "friendship, teamwork and communication",
  "student clubs, volunteering and community activities",
  "books, films, music and cultural experiences",
  "career planning, workplace skills and future goals",
  "money management, shopping and consumer choices",
  "travel, cultural differences and adapting to new places",
  "public manners, rules and personal responsibility",
  "important decisions, useful experiences and personal change",
  "city life, countryside life and places on campus",
];

const recentPart1Questions = [];

function choosePart1Categories() {
  const shuffled = [...part1CategoryPool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 2);
}

function rememberPart1Questions(questions) {
  recentPart1Questions.push(...questions.map((question) => String(question).trim()));
  if (recentPart1Questions.length > 24) recentPart1Questions.splice(0, recentPart1Questions.length - 24);
}

function questionWords(question) {
  const stopWords = new Set(["what", "which", "how", "why", "do", "does", "did", "would", "could", "should", "you", "your", "the", "a", "an", "and", "or", "to", "in", "on", "of", "is", "are"]);
  return new Set(String(question).toLowerCase().match(/[a-z]+/g)?.filter((word) => word.length > 2 && !stopWords.has(word)) || []);
}

function questionSimilarity(left, right) {
  const a = questionWords(left);
  const b = questionWords(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  return [...a].filter((word) => b.has(word)).length / union.size;
}

function part1QuestionsNeedRepair(questions, recentQuestions = recentPart1Questions) {
  if (!Array.isArray(questions) || questions.length !== 2) return true;
  if (questions.some((question) => /(spare time|free time|weekend)/i.test(question))) return true;
  if (questionSimilarity(questions[0], questions[1]) >= 0.45) return true;
  return questions.some((question) => recentQuestions.some((recent) => questionSimilarity(question, recent) >= 0.55));
}

const demoExam = {
  title: "Technology and Independent Thinking",
  theme: "科技如何影响大学生的独立思考",
  part1: {
    introPrompt: "Good morning. Please introduce yourself briefly.",
    questions: [
      "Which campus facility would you most like your university to improve, and why?",
      "How do you usually deal with pressure before an important examination?",
    ],
  },
  part2: {
    statementPrompt: "Some people believe AI tools make university students less independent, while others think they improve learning. State your opinion and support it with reasons and examples.",
    keyPoints: ["your position", "an example from study", "possible risks", "responsible use"],
    discussionOpening: "I think AI is useful, but students may rely on it too much. Where should universities draw the line?",
  },
  part3: {
    questions: [
      "How should teachers redesign assignments in the age of AI?",
    ],
  },
};

function asStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);
  return items.length ? items : [...fallback];
}

function normalizedScore(value, fallback = 3) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : fallback;
}

function relaxedTrainingScore(value) {
  const score = normalizedScore(value);
  if (score < 1.5) return score;
  return Number(Math.min(5, score + 0.35).toFixed(1));
}

function normalizeTemplateAnswer(value, fallbackText) {
  const answer = value && typeof value === "object" ? value : {};
  return {
    opinion: String(answer.opinion || "A clear response should begin with a direct main idea."),
    reason1: String(answer.reason1 || "The first reason should explain why the idea matters."),
    example1: String(answer.example1 || "A short concrete example can support the first reason."),
    reason2: String(answer.reason2 || "The second reason should add another useful perspective."),
    example2: String(answer.example2 || "Another example can make the response more convincing."),
    conclusion: String(answer.conclusion || "A brief conclusion should restate the main response."),
    fullAnswer: String(answer.fullAnswer || fallbackText),
    estimatedSeconds: Math.max(1, Math.min(180, Number(answer.estimatedSeconds) || 20)),
  };
}

function normalizeAnswerAnalysis(value) {
  const analysis = value && typeof value === "object" ? value : {};
  return {
    ...analysis,
    accuracyRange: normalizedScore(analysis.accuracyRange),
    coherence: normalizedScore(analysis.coherence),
    flexibility: normalizedScore(analysis.flexibility),
    pronunciation: normalizedScore(analysis.pronunciation),
    relevance: normalizedScore(analysis.relevance),
    summary: String(analysis.summary || "本次作答基本完成了任务，建议继续加强表达的完整性和具体性。"),
    evidence: asStringArray(analysis.evidence, ["已根据转写文本和录音指标完成分析。"]),
    corrections: asStringArray(analysis.corrections),
    nextStep: String(analysis.nextStep || "下一次作答时先明确观点，再补充理由和具体例子。"),
    optimizedAnswer: normalizeTemplateAnswer(analysis.optimizedAnswer, "Please use the fixed structure to give a clearer version of your response."),
    standardAnswer: normalizeTemplateAnswer(analysis.standardAnswer, "Please use the fixed structure to give a complete reference answer."),
  };
}

function normalizeExam(value) {
  const exam = value && typeof value === "object" ? value : {};
  const part1 = exam.part1 && typeof exam.part1 === "object" ? exam.part1 : {};
  const part2 = exam.part2 && typeof exam.part2 === "object" ? exam.part2 : {};
  const part3 = exam.part3 && typeof exam.part3 === "object" ? exam.part3 : {};
  const questions1 = asStringArray(part1.questions, demoExam.part1.questions).slice(0, 2);
  while (questions1.length < 2) questions1.push(demoExam.part1.questions[questions1.length]);
  return {
    title: String(exam.title || demoExam.title),
    theme: String(exam.theme || demoExam.theme),
    part1: { introPrompt: "Good morning. Please introduce yourself briefly.", questions: questions1 },
    part2: {
      statementPrompt: String(part2.statementPrompt || demoExam.part2.statementPrompt),
      keyPoints: asStringArray(part2.keyPoints, demoExam.part2.keyPoints).slice(0, 4),
      discussionOpening: String(part2.discussionOpening || demoExam.part2.discussionOpening),
    },
    part3: { questions: asStringArray(part3.questions, demoExam.part3.questions).slice(0, 1) },
  };
}

function normalizeFinalResult(value, answers) {
  const result = value && typeof value === "object" ? value : {};
  const sections = [...new Set(answers.map((answer) => String(answer.section || "本次训练")))];
  const reviews = Array.isArray(result.sectionReviews)
    ? result.sectionReviews.filter((item) => item && typeof item === "object").map((item) => ({ section: String(item.section || "分环节"), comment: String(item.comment || "已完成本环节作答。") }))
    : [];
  return {
    ...result,
    accuracyRange: normalizedScore(result.accuracyRange),
    coherence: normalizedScore(result.coherence),
    flexibility: normalizedScore(result.flexibility),
    verdict: String(result.verdict || "本次模拟已完成，整体表达能够传递主要信息。"),
    strengths: asStringArray(result.strengths, ["能够围绕题目完成基本表达。"]),
    weaknesses: asStringArray(result.weaknesses, ["部分回答还可以增加理由和具体例子。"]),
    actionPlan: asStringArray(result.actionPlan, ["继续使用固定模板练习。", "复述优化版答案。", "控制停顿并提高表达完整度。"]),
    sectionReviews: reviews.length ? reviews : sections.map((section) => ({ section, comment: "已完成本环节作答，建议继续提升内容展开和表达流畅度。" })),
  };
}

function assertApi() {
  if (!deepseek && !demoMode) {
    const error = new Error("尚未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填写密钥。");
    error.status = 503;
    throw error;
  }
}

function parseModelJson(value) {
  const text = String(value || "").trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  const extracted = firstBrace >= 0 && lastBrace > firstBrace ? unfenced.slice(firstBrace, lastBrace + 1) : unfenced;
  for (const candidate of [unfenced, extracted]) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(jsonrepair(candidate));
      } catch {
        // Try the next candidate before reporting an invalid model response.
      }
    }
  }
  throw new Error("AI 返回的结构化结果格式异常，系统已尝试自动修复但未成功，请重试本题。");
}

async function requestJson(messages) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryMessage = attempt === 0 ? [] : [{ role: "user", content: "Your previous JSON was malformed. Generate the complete result again as one strictly valid JSON object. Escape all quotation marks and line breaks inside string values." }];
    const response = await deepseek.chat.completions.create({
      model: textModel,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [...messages, ...retryMessage],
    });
    try {
      return parseModelJson(response.choices[0].message.content);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function structuredResponse({ name, schema, instructions, input }) {
  return requestJson([
    {
      role: "system",
      content: `${instructions}\nReturn only a valid JSON object named ${name}, without Markdown fences. Escape quotation marks inside strings. It must conform exactly to this JSON Schema: ${JSON.stringify(schema)}`,
    },
    { role: "user", content: input },
  ]);
}

async function transcribeWithDeepSeek(file) {
  const form = new FormData();
  form.append("file", new Blob([file.buffer], { type: file.mimetype || "audio/wav" }), file.originalname || "answer.wav");
  const response = await fetch(`${baseURL}/v1/tools/asr`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `DeepSeek ASR 请求失败 (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return String(data.text || "").trim();
}

app.get("/api/status", (_req, res) => {
  res.json({ ready: hasApiKey, demoMode, provider: "DeepSeek", models: { textModel, speechRecognition: "DeepSeek ASR" } });
});

app.post("/api/exam/generate", async (req, res, next) => {
  try {
    assertApi();
    if (demoMode) return res.json(normalizeExam(demoExam));
    const focus = String(req.body?.focus || "general social and campus topics").slice(0, 200);
    const difficulty = ["standard", "challenging"].includes(req.body?.difficulty) ? req.body.difficulty : "standard";
    const clientRecentQuestions = Array.isArray(req.body?.recentPart1Questions)
      ? req.body.recentPart1Questions.slice(-30).map((question) => String(question).slice(0, 240))
      : [];
    const allRecentQuestions = [...new Set([...recentPart1Questions, ...clientRecentQuestions])].slice(-40);
    const [part1CategoryA, part1CategoryB] = choosePart1Categories();
    const recentQuestions = allRecentQuestions.length ? allRecentQuestions.map((question) => `- ${question}`).join("\n") : "- None yet";
    let exam = await structuredResponse({
      name: "cet6_speaking_exam",
      schema: examSchema,
      instructions: `You design authentic Chinese CET-SET6 speaking mock tests, not IELTS questions and not creative interview questions. Follow this structure exactly.

Part 1:
- introPrompt must be exactly: "Good morning. Please introduce yourself briefly."
- The introduction is completely free. Never require a major, university, workplace, hobby, hometown, shared space, achievement, or any other specified detail.
- Then provide exactly two short, natural examiner questions suitable for a 30-second answer each.
- Question 1 MUST use this assigned category: ${part1CategoryA}.
- Question 2 MUST use this different assigned category: ${part1CategoryB}.
- Each question must contain only one main idea, use roughly 8-18 English words, and be answerable in 2-4 spoken sentences within 30 seconds.
- Vary the question form across tests: ask for a preference, reason, method, experience, comparison, improvement, choice, challenge, influence or practical suggestion.
- Do not ask about spare time, free time or weekend activities in this test. Those topics have been overused.
- Do not make both questions begin with the same question word or use near-identical sentence patterns.
- Avoid semantically repeating any question in the recent-question list supplied by the user message.
- Keep the situation familiar to an ordinary university student. Avoid obscure scenarios, specialist knowledge and broad abstract debate in Part 1.

Part 2 individual presentation:
- Create one clear 90-second issue that invites a position, explanation, causes, effects, comparison, or solutions.
- Match authentic topic styles such as: whether AI should replace human jobs; social media and interpersonal relationships; balancing economic development and environmental protection; banning plastic packaging; online versus traditional education; student entrepreneurship; extracurricular participation; vegetarian diets; culture shock; commercialization of traditional festivals.

Part 2 discussion:
- discussionOpening must sound like the other candidate's brief opening view followed by one focused invitation to respond.
- Use a debatable campus or social issue such as smartphone bans in classrooms, student part-time jobs, space exploration, consumerism, online education, entrepreneurship, technology, environment, employment, finance, transport, social media, or cultural differences.
- The issue must support disagreement, examples and follow-up discussion for about three minutes.

Part 3:
- Provide exactly one 45-second examiner question connected to the broader Part 2 theme. It should ask for a judgment, reason, consequence, or practical solution.

Target ${difficulty} CET-6 level. Use concise natural English. Avoid obscure specialist knowledge, compound multi-part questions, forced personal disclosure, vague philosophical prompts, and answer keys.`,
      input: `Create one original CET-SET6 mock exam. Preferred broad focus: ${focus}. Vary the topic across requests and imitate the style, scope and clarity of real CET-SET6 samples without copying a sample verbatim.

Recently used Part 1 questions that must not be repeated or lightly paraphrased:
${recentQuestions}`,
    });
    exam = normalizeExam(exam);
    exam.part1.introPrompt = "Good morning. Please introduce yourself briefly.";
    exam.part1.questions = exam.part1.questions.slice(0, 2);
    if (part1QuestionsNeedRepair(exam.part1.questions, allRecentQuestions)) {
      const repaired = await structuredResponse({
        name: "diverse_part1_questions",
        schema: part1QuestionsSchema,
        instructions: `Write exactly two diverse CET-SET6 Part 1 examiner questions. Each must be a single familiar question answerable by a university student in 2-4 sentences within 30 seconds. Question 1 must concern ${part1CategoryA}; Question 2 must concern ${part1CategoryB}. Use different question forms. Do not mention spare time, free time or weekends. Do not repeat or lightly paraphrase any forbidden question. Use concise natural English and no explanations.`,
        input: `Replace these insufficiently diverse questions: ${JSON.stringify(exam.part1.questions)}\nForbidden recent questions: ${JSON.stringify(allRecentQuestions)}`,
      });
      exam.part1.questions = asStringArray(repaired?.questions, exam.part1.questions).slice(0, 2);
    }
    exam.part3.questions = exam.part3.questions.slice(0, 1);
    rememberPart1Questions(exam.part1.questions);
    res.json(exam);
  } catch (error) {
    next(error);
  }
});

app.post("/api/answer/analyze", upload.single("audio"), async (req, res, next) => {
  try {
    assertApi();
    if (!req.file) return res.status(400).json({ error: "没有收到录音文件。" });
    const task = String(req.body.task || "CET-SET6 speaking response").slice(0, 2000);
    const duration = Number(req.body.duration || 0);
    const maxSeconds = Math.max(10, Math.min(180, Number(req.body.maxSeconds || 45)));
    const metrics = String(req.body.metrics || "{}").slice(0, 2000);
    const minWords = Math.max(18, Math.round(maxSeconds * 1.8));
    const maxWords = Math.max(minWords + 8, Math.round(maxSeconds * 2.15));
    if (demoMode) {
      return res.json({
        transcript: "演示模式：配置 DeepSeek API Key 后可获得真实转写。",
        analysis: {
          accuracyRange: 3, coherence: 3, flexibility: 3, pronunciation: 3, relevance: 3,
          summary: "演示模式不会对你的真实语音进行判断。",
          evidence: ["已成功完成录音流程"], corrections: [], nextStep: "配置 API Key 后重新作答。",
          optimizedAnswer: {
            opinion: "I would like to give a clear answer to this question.",
            reason1: "My first reason is practical and closely related to daily life.",
            example1: "For example, it can help students make better use of their time.",
            reason2: "Another reason is that it can support personal development.",
            example2: "For instance, students may gain useful experience through it.",
            conclusion: "Therefore, I believe it is generally a positive choice.",
            fullAnswer: "This is a demonstration of the optimized answer template. Configure the DeepSeek API key to generate an answer based on your own response.",
            estimatedSeconds: Math.min(maxSeconds, 15),
          },
          standardAnswer: {
            opinion: "In my view, this issue should be considered carefully.",
            reason1: "First, it has a direct influence on students' daily lives.",
            example1: "For example, a suitable policy can improve learning efficiency.",
            reason2: "Second, it may also affect students' long-term development.",
            example2: "For instance, students can learn to make responsible decisions.",
            conclusion: "For these reasons, a balanced approach would be the best choice.",
            fullAnswer: "This is a demonstration of the standard answer template. Configure the DeepSeek API key to generate a task-specific standard answer.",
            estimatedSeconds: Math.min(maxSeconds, 15),
          },
          averageScore: 3, grade: "C", qualified: true,
        },
      });
    }

    const transcript = await transcribeWithDeepSeek(req.file);
    let analysis = await requestJson([
        {
          role: "system",
          content: `You are a supportive but discriminating CET-SET6 training examiner. Judge only evidence present in the transcript and acoustic measurements. Inspect grammar, vocabulary, organization, relevance, flexibility and appropriateness. Use duration and silence ratio only as limited proxy evidence for fluency and delivery; never claim to have directly heard phoneme accuracy, stress or intonation.

SCORING CALIBRATION:
- This is formative training, so reward successful communication instead of demanding near-perfect English.
- A relevant response whose meaning is generally clear and sustained should normally receive about 3.0-3.5 even with several minor grammar or word-choice errors.
- A response with a clear point, supporting reasons and a concrete example, which remains easy to understand, may receive about 3.5-4.2.
- Do not deduct pronunciation points for phonemes, stress or intonation that cannot be reliably judged from ASR and browser metrics.
- Give scores below 2.5 mainly for an empty response, severe irrelevance, extremely limited content, or speech that is mostly unintelligible.
- Keep useful score distinctions; do not automatically award 4 or above. A score near 5 still requires an excellent response.

LANGUAGE RULES:
- summary, evidence, corrections and nextStep MUST be concise Simplified Chinese.
- optimizedAnswer and standardAnswer MUST be English.
- Use short, clear CET-6-level sentences. Avoid complex academic language and long subordinate clauses.
- summary must contain no more than three short Chinese sentences; evidence and corrections should contain no more than two items each; nextStep must be one actionable Chinese sentence.

FIXED ANSWER TEMPLATE:
For BOTH optimizedAnswer and standardAnswer, always fill exactly these six steps:
1. opinion: one direct viewpoint or main response.
2. reason1: the first reason.
3. example1: one concrete example supporting reason1.
4. reason2: the second reason.
5. example2: one concrete example supporting reason2.
6. conclusion: one short concluding sentence.
Then combine those six steps, in the same order, into fullAnswer. Do not add any other section or structure.

optimizedAnswer must preserve the candidate's original viewpoint and useful examples whenever the transcript provides them. Correct grammar and vocabulary, simplify awkward wording, and fill only the missing structural pieces. Do not replace the candidate's position with a different one.

standardAnswer must be an independent high-quality reference answer to the same task, using the same fixed six-step template. It may choose the clearest defensible viewpoint.

Each fullAnswer must contain approximately ${minWords}-${maxWords} English words and must be speakable within ${maxSeconds} seconds. Each individual template field should contain only one short sentence. Set estimatedSeconds to a realistic integer no greater than ${maxSeconds}.

For a self-introduction task, keep the same JSON fields but interpret them as: opinion = opening and main personal information; reason1 = personal detail one; example1 = example for detail one; reason2 = personal detail two; example2 = example for detail two; conclusion = closing. Do not force any personal detail not present in the candidate transcript for optimizedAnswer.

Return only one valid JSON object without markdown fences. Escape every quotation mark and line break inside JSON string values. Match this JSON Schema: ${JSON.stringify(answerSchema)}. The pronunciation score is a training proxy based on ASR intelligibility and acoustic measurements, and the Chinese summary must say when evidence is insufficient.`,
        },
        {
          role: "user",
          content: `Task: ${task}\nMaximum response time: ${maxSeconds} seconds\nCandidate transcript returned by DeepSeek ASR: ${transcript || "[No reliable transcript]"}\nRecorded duration: ${duration.toFixed(1)} seconds\nBrowser acoustic metrics: ${metrics}`,
        },
      ]);
    analysis = normalizeAnswerAnalysis(analysis);
    analysis = await ensureAnswerChinese(analysis);
    analysis = normalizeAnswerAnalysis(analysis);
    analysis.accuracyRange = relaxedTrainingScore(analysis.accuracyRange);
    analysis.coherence = relaxedTrainingScore(analysis.coherence);
    analysis.flexibility = relaxedTrainingScore(analysis.flexibility);
    analysis.pronunciation = relaxedTrainingScore(analysis.pronunciation);
    analysis.relevance = relaxedTrainingScore(analysis.relevance);
    const answerScores = [analysis.accuracyRange, analysis.coherence, analysis.flexibility, analysis.pronunciation, analysis.relevance].map(Number);
    analysis.averageScore = Number((answerScores.reduce((sum, score) => sum + score, 0) / answerScores.length).toFixed(2));
    analysis.grade = gradeFromFive(analysis.averageScore);
    analysis.qualified = isQualifiedGrade(analysis.grade);
    res.json({ transcript, analysis });
  } catch (error) {
    next(error);
  }
});

app.post("/api/discussion/next", async (req, res, next) => {
  try {
    assertApi();
    if (demoMode) return res.json({ prompt: "That is interesting. Could you give a specific example and respond to one possible objection?" });
    const topic = String(req.body?.topic || "the assigned topic").slice(0, 1000);
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
    const response = await deepseek.chat.completions.create({
      model: textModel,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "Act as the other candidate in a CET-SET6 paired discussion. Reply in natural spoken English in 1-2 short sentences. Briefly react to the candidate, then disagree, extend, compare, or ask one focused follow-up. Never give a long speech. Keep the exchange moving." },
        { role: "user", content: `Topic: ${topic}\nConversation so far:\n${history.map((x) => `${x.role}: ${x.text}`).join("\n")}` },
      ],
    });
    res.json({ prompt: response.choices[0].message.content.trim() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/exam/final-score", async (req, res, next) => {
  try {
    assertApi();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!answers.length) return res.status(400).json({ error: "没有可评分的作答。" });
    if (demoMode) {
      return res.json({
        accuracyRange: 3, coherence: 3, flexibility: 3, total: 9, level: "合格", grade: "C", qualified: true,
        verdict: "这是演示结果，不代表真实评分。配置 API Key 后可获得逐音频训练评价。",
        strengths: ["完成了考试流程"], weaknesses: ["演示模式无真实语言证据"],
        actionPlan: ["配置 API Key", "完成一次完整模拟", "根据逐题纠错复练"],
        sectionReviews: [{ section: "演示", comment: "暂无真实评分。" }],
      });
    }
    const compact = answers.map((a, index) => ({
      index: index + 1,
      section: a.section,
      task: a.task,
      transcript: a.transcript,
      duration: a.duration,
      metrics: a.metrics,
      analysis: {
        accuracyRange: a.analysis?.accuracyRange,
        coherence: a.analysis?.coherence,
        flexibility: a.analysis?.flexibility,
        pronunciation: a.analysis?.pronunciation,
        relevance: a.analysis?.relevance,
        averageScore: a.analysis?.averageScore,
        grade: a.analysis?.grade,
        summary: a.analysis?.summary,
        evidence: a.analysis?.evidence,
      },
    }));
    let result = await structuredResponse({
      name: "cet6_final_score",
      schema: finalSchema,
      instructions: `You are the senior rater for a CET-SET6 mock speaking training test. Use a supportive, moderately lenient version of the 15-point analytic rubric: (1) Accuracy and Range; (2) Size and Coherence of Discourse; (3) Flexibility and Appropriateness. Each dimension is 0-5. Reward communication that is relevant, understandable and sustained. Minor grammar, vocabulary and delivery errors should not prevent a middle or upper-middle score. A candidate who generally completes the tasks and communicates the main meaning should normally be around the passing range. Reserve low scores mainly for missing, extremely short, seriously irrelevant or mostly unintelligible responses. Do not claim to judge phonemes, stress or intonation when ASR evidence cannot support that judgment. Keep meaningful distinctions and reserve scores near 5 for genuinely excellent performance. Use cross-task evidence and do not average the per-answer scores mechanically. All feedback fields, including verdict, strengths, weaknesses, actionPlan and every sectionReviews.comment, MUST be concise Simplified Chinese with specific evidence. Short quoted English evidence is allowed. The program will calculate the total and letter grade, so do not invent a letter grade.`,
      input: `Produce a final holistic assessment from these responses:\n${JSON.stringify(compact)}`,
    });
    result = normalizeFinalResult(result, answers);
    result = await ensureFinalChinese(result);
    result = normalizeFinalResult(result, answers);
    result.accuracyRange = relaxedTrainingScore(result.accuracyRange);
    result.coherence = relaxedTrainingScore(result.coherence);
    result.flexibility = relaxedTrainingScore(result.flexibility);
    result.total = Number(([result.accuracyRange, result.coherence, result.flexibility].map(Number).reduce((sum, score) => sum + score, 0)).toFixed(1));
    result.grade = gradeFromTotal(result.total);
    result.qualified = isQualifiedGrade(result.grade);
    result.level = result.grade.startsWith("A") ? "优秀" : result.grade.startsWith("B") ? "良好" : result.qualified ? "合格" : "未达合格";
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const message = error?.error?.message || error?.message || "服务器处理失败。";
  res.status(error.status || error.statusCode || 500).json({ error: message });
});

app.listen(port, () => {
  console.log(`CET-SET6 speaking simulator: http://localhost:${port}`);
  if (!hasApiKey) console.log("DEEPSEEK_API_KEY is not configured. Set DEMO_MODE=true to preview the interface.");
});
