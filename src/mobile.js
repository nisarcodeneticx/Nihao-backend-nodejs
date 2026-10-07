const express = require('express');
const { query, queryOne } = require('./db');
const { notFound, isLive, num, text } = require('./util');
const { ensureCourseProgress, liveUnits, liveLessons, countWords, courseProgressDto, coursePercent, courseListStats, league } = require('./progress');

const router = express.Router();

router.get('/v1/courses', async (req, res, next) => {
  try {
    const courses = (await query('SELECT * FROM courses ORDER BY created_at ASC NULLS LAST')).filter((row) => isLive(row.status));
    const stats = await courseListStats(userId(req), courses.map((course) => course.id));
    const items = courses.map((course) => ({
      id: course.id,
      title: courseTitle(course),
      level: text(course.difficulty, 'Beginner'),
      totalUnits: stats.units.get(course.id) || 0,
      totalWords: stats.words.get(course.id) || 0,
      premium: false,
      unlocked: true,
      progress: stats.progress.get(course.id) || 0,
      coverImageUrl: course.cover_image_url
    }));
    res.json(okList('Courses fetched successfully', items));
  } catch (error) { next(error); }
});

router.get('/v1/courses/:courseId', async (req, res, next) => {
  try {
    const id = userId(req);
    if (id) await ensureCourseProgress(id, req.params.courseId);
    const course = await publishedCourse(req.params.courseId);
    const units = await liveUnits(course.id);
    res.json(okList('Course detail fetched successfully', {
      id: course.id,
      title: courseTitle(course),
      description: { ur: text(course.description, course.name), en: text(course.description, course.name) },
      level: text(course.difficulty, 'Beginner'),
      totalUnits: units.length,
      totalWords: await countWords(course.id),
      premium: false,
      progress: id ? await coursePercent(id, course.id) : 0,
      version: '1.0.0',
      units: await Promise.all(units.map(unitSummary))
    }));
  } catch (error) { next(error); }
});

router.get('/v1/courses/:courseId/progress', async (req, res, next) => {
  try {
    const id = userId(req);
    const data = id
      ? await courseProgressDto(id, req.params.courseId)
      : await guestCourseProgress(req.params.courseId);
    res.json(okList('Course progress fetched successfully', data));
  } catch (error) { next(error); }
});

router.get('/v1/league', async (req, res, next) => {
  try {
    const id = userId(req);
    const data = id ? await league(id) : { name: 'gold', yourRank: 0, entries: [] };
    res.json(okList('League fetched successfully', data));
  } catch (error) { next(error); }
});

router.get('/v1/courses/:courseId/units', async (req, res, next) => {
  try {
    const id = userId(req);
    if (id) await ensureCourseProgress(id, req.params.courseId);
    await publishedCourse(req.params.courseId);
    const all = await liveUnits(req.params.courseId);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const limit = Math.max(Number(req.query.limit || 10), 1);
    const from = Math.min(offset, all.length);
    const slice = all.slice(from, Math.min(from + limit, all.length));
    const unitIds = slice.map((unit) => unit.id);
    const lessonRows = unitIds.length
      ? (await query(
        'SELECT * FROM lessons WHERE unit_id = ANY($1::text[]) ORDER BY lesson_number ASC',
        [unitIds]
      )).filter((lesson) => isLive(lesson.status))
      : [];
    const lessonsByUnit = new Map();
    for (const lesson of lessonRows) {
      if (!lessonsByUnit.has(lesson.unit_id)) lessonsByUnit.set(lesson.unit_id, []);
      lessonsByUnit.get(lesson.unit_id).push(lesson);
    }
    const progressRows = id && unitIds.length
      ? await query(
        'SELECT * FROM user_unit_progress WHERE user_id = $1 AND unit_id = ANY($2::text[])',
        [id, unitIds]
      )
      : [];
    const progressByUnit = new Map(progressRows.map((row) => [row.unit_id, row]));
    const nodes = slice.map((unit, index) => unitNode(
      unit,
      offset + index,
      lessonsByUnit.get(unit.id) || [],
      id ? progressByUnit.get(unit.id) : null
    ));
    res.json(okList('Units fetched successfully', nodes));
  } catch (error) { next(error); }
});

router.get('/v1/units/:unitId', async (req, res, next) => {
  try {
    const unit = await publishedUnit(req.params.unitId);
    const id = userId(req);
    if (id) await ensureCourseProgress(id, unit.course_id);
    const lessons = await liveLessons(unit.id);
    res.json(okList('Unit detail fetched successfully', {
      id: unit.id,
      title: { ur: unit.urdu_title, en: unit.hanzi_title },
      hanziTitle: unit.hanzi_title,
      grammarPoint: localized(text(unit.grammar_point)),
      totalLessons: lessons.length,
      totalItems: lessons.reduce((sum, lesson) => sum + num(lesson.words_count), 0),
      premium: false,
      packVersion: 'v' + num(unit.version, 1) + '.0',
      lessons: lessons.map(lessonBrief)
    }));
  } catch (error) { next(error); }
});

router.get('/v1/units/:unitId/lessons', async (req, res, next) => {
  try {
    const unit = await publishedUnit(req.params.unitId);
    const id = userId(req);
    if (id) await ensureCourseProgress(id, unit.course_id);
    const lessons = await liveLessons(unit.id);
    const rows = id && lessons.length
      ? await query('SELECT * FROM user_lesson_progress WHERE user_id = $1 AND lesson_id = ANY($2::text[])', [id, lessons.map((lesson) => lesson.id)])
      : [];
    const map = new Map(rows.map((row) => [row.lesson_id, row]));
    const units = await liveUnits(unit.course_id);
    const firstUnit = units.length > 0 && units[0].id === unit.id;
    res.json(okList('Lessons fetched successfully', lessons.map((lesson, index) => {
      if (!id && firstUnit && index === 0) {
        return lessonJourney(lesson, { earned_crowns: 0, is_complete: false, state: 'available' });
      }
      return lessonJourney(lesson, map.get(lesson.id));
    })));
  } catch (error) { next(error); }
});

router.get('/v1/lessons/:lessonId/exercises', async (req, res, next) => {
  try {
    const lesson = await publishedLesson(req.params.lessonId);
    const exercises = teachThenQuiz(await query('SELECT * FROM exercises WHERE lesson_id = $1 ORDER BY exercise_order ASC', [lesson.id]));
    res.json(okList('Exercises fetched successfully', exercises.map((exercise) => exerciseNode(exercise, lesson))));
  } catch (error) { next(error); }
});

router.get('/v1/items/:itemId', async (req, res, next) => {
  try {
    const item = await queryOne('SELECT * FROM vocabulary WHERE id = $1', [req.params.itemId]);
    if (!item) throw notFound('Vocabulary item not found: ' + req.params.itemId);
    res.json(okList('Item details fetched successfully', await vocabularyDetail(item)));
  } catch (error) { next(error); }
});

router.get('/v1/api/lessons/:lessonId', async (req, res, next) => {
  try {
    const lesson = await publishedLesson(req.params.lessonId);
    const exercises = teachThenQuiz(await query('SELECT * FROM exercises WHERE lesson_id = $1 ORDER BY exercise_order ASC', [lesson.id]));
    res.json(okList('Lesson fetched successfully', {
      id: lesson.id,
      lessonNumber: lesson.lesson_number,
      lessonType: mobileLessonType(lesson.lesson_type),
      urduTitle: lesson.urdu_title,
      instructionText: text(lesson.instruction_text),
      difficulty: text(lesson.difficulty, 'Easy'),
      crowns: num(lesson.crowns, 3),
      exercisesCount: num(lesson.exercises_count, exercises.length),
      wordsCount: num(lesson.words_count),
      exercises: exercises.map((exercise) => ({
        id: exercise.id,
        exerciseType: mobileExerciseType(exercise.exercise_type),
        exerciseData: dataOf(exercise.exercise_data),
        exerciseOrder: exercise.exercise_order
      }))
    }));
  } catch (error) { next(error); }
});

router.get('/v1/api/vocabulary', async (req, res, next) => {
  try {
    const params = [];
    let sql = 'SELECT * FROM vocabulary WHERE 1=1';
    if (req.query.hskLevel) {
      params.push(Number(req.query.hskLevel));
      sql += ` AND hsk_level = $${params.length}`;
    }
    if (text(req.query.search)) {
      params.push('%' + String(req.query.search).trim() + '%');
      sql += ` AND (hanzi ILIKE $${params.length} OR pinyin ILIKE $${params.length} OR urdu_translation ILIKE $${params.length})`;
    }
    sql += ' ORDER BY created_at DESC NULLS LAST';
    const rows = await query(sql, params);
    const ids = rows.map((item) => item.id);
    const exampleRows = ids.length
      ? await query('SELECT * FROM example_sentences WHERE vocabulary_id = ANY($1::text[])', [ids])
      : [];
    const topicRows = ids.length
      ? await query('SELECT vocabulary_id, topic FROM vocabulary_topics WHERE vocabulary_id = ANY($1::text[])', [ids])
      : [];
    const examplesByWord = new Map();
    for (const example of exampleRows) {
      if (!examplesByWord.has(example.vocabulary_id)) examplesByWord.set(example.vocabulary_id, []);
      examplesByWord.get(example.vocabulary_id).push(example);
    }
    const topicsByWord = new Map();
    for (const topic of topicRows) {
      if (!topicsByWord.has(topic.vocabulary_id)) topicsByWord.set(topic.vocabulary_id, []);
      topicsByWord.get(topic.vocabulary_id).push(topic.topic);
    }
    res.json(okList('Vocabulary fetched successfully', rows.map((item) => vocabularyListItem(
      item,
      examplesByWord.get(item.id) || [],
      topicsByWord.get(item.id) || []
    ))));
  } catch (error) { next(error); }
});

function okList(message, data) {
  return { success: true, message, data };
}

function userId(req) {
  return req.user ? req.user.id : null;
}

async function guestCourseProgress(courseId) {
  const course = await publishedCourse(courseId);
  const units = await liveUnits(course.id);
  return {
    xp: 0,
    level: 1,
    streak: 0,
    completedUnits: 0,
    totalUnits: units.length,
    completedWords: 0,
    totalWords: await countWords(course.id),
    totalCrowns: 0
  };
}

async function publishedCourse(id) {
  const course = await queryOne('SELECT * FROM courses WHERE id = $1', [id]);
  if (!course || !isLive(course.status)) throw notFound('Course not found: ' + id);
  return course;
}

async function publishedUnit(id) {
  const unit = await queryOne('SELECT * FROM units WHERE id = $1', [id]);
  if (!unit || !isLive(unit.status)) throw notFound('Unit not found: ' + id);
  return unit;
}

async function publishedLesson(id) {
  const lesson = await queryOne('SELECT * FROM lessons WHERE id = $1', [id]);
  if (!lesson || !isLive(lesson.status)) throw notFound('Lesson not found: ' + id);
  return lesson;
}

function courseTitle(course) {
  return { ur: text(course.description, course.name), en: course.name };
}

async function unitSummary(unit) {
  const lessons = await liveLessons(unit.id);
  return {
    id: unit.id,
    unitNumber: unit.unit_number,
    urduTitle: unit.urdu_title,
    hanziTitle: unit.hanzi_title,
    grammarPoint: localized(text(unit.grammar_point)),
    hskLevel: text(unit.hsk_level, '1'),
    topics: await topics('unit_topics', 'unit_id', unit.id),
    estimatedTime: num(unit.estimated_time, 20),
    difficulty: text(unit.difficulty, 'Easy'),
    learningObjectives: await objectives(unit.id),
    lessonCount: lessons.length,
    wordCount: lessons.reduce((sum, lesson) => sum + num(lesson.words_count), 0)
  };
}

async function unitJourney(unit, index, id) {
  const lessons = await liveLessons(unit.id);
  const progress = id
    ? await queryOne('SELECT * FROM user_unit_progress WHERE user_id = $1 AND unit_id = $2', [id, unit.id])
    : null;
  return unitNode(unit, index, lessons, progress);
}

function unitNode(unit, index, lessons, progress) {
  const totalItems = lessons.reduce((sum, lesson) => sum + num(lesson.words_count), 0);
  const hasCheckpoint = lessons.some((lesson) => String(lesson.lesson_type).toUpperCase() === 'CHECKPOINT');
  const base = {
    id: unit.id,
    index,
    title: { ur: unit.urdu_title, en: unit.hanzi_title },
    hanziTitle: unit.hanzi_title,
    totalLessons: lessons.length,
    totalItems,
    hasCheckpoint,
    premium: false
  };
  if (!progress) {
    return { ...base, state: index === 0 ? 'active' : 'locked', completedLessons: 0, completedItems: 0, crowns: 0, checkpointCompleted: false, unlocked: index === 0 };
  }
  return {
    ...base,
    state: progress.state,
    completedLessons: num(progress.completed_lessons),
    completedItems: num(progress.completed_items),
    crowns: num(progress.crowns),
    checkpointCompleted: progress.checkpoint_completed,
    unlocked: progress.is_unlocked
  };
}

function lessonJourney(lesson, progress) {
  const base = {
    id: lesson.id,
    index: lesson.lesson_number,
    type: mobileLessonType(lesson.lesson_type),
    title: { ur: lesson.urdu_title, en: lesson.urdu_title },
    items: num(lesson.words_count),
    crowns: num(lesson.crowns, 3),
    premium: false
  };
  if (!progress) return { ...base, earnedCrowns: 0, complete: false, state: 'locked' };
  return { ...base, earnedCrowns: num(progress.earned_crowns), complete: progress.is_complete, state: progress.state };
}

function lessonBrief(lesson) {
  return {
    id: lesson.id,
    lessonNumber: lesson.lesson_number,
    lessonType: mobileLessonType(lesson.lesson_type),
    urduTitle: lesson.urdu_title,
    instructionText: text(lesson.instruction_text),
    difficulty: text(lesson.difficulty, 'Easy'),
    crowns: num(lesson.crowns, 3),
    exercisesCount: num(lesson.exercises_count),
    wordsCount: num(lesson.words_count)
  };
}

function exerciseNode(exercise, lesson) {
  const data = dataOf(exercise.exercise_data);
  return {
    id: exercise.id,
    type: mobileExerciseType(exercise.exercise_type),
    prompt: extractPrompt(data, lesson),
    items: stringList(data, 'items'),
    options: stringList(data, 'options'),
    answer: firstText(data, ['answer', 'correctAnswer', 'word']),
    gloss: extractGloss(data),
    audioId: firstText(data, ['audioId', 'audio']),
    hint: extractHint(data),
    pinyin: firstText(data, ['pinyin'])
  };
}

async function vocabularyDetail(item) {
  const examples = await query('SELECT * FROM example_sentences WHERE vocabulary_id = $1', [item.id]);
  return {
    id: item.id,
    hanzi: item.hanzi,
    pinyin: item.pinyin,
    urdu: item.urdu_translation,
    romanUrdu: text(item.roman_urdu),
    glossUr: item.literal_gloss,
    audioIds: { male: item.audio_male_url, female: item.audio_female_url },
    illustration: item.illustration_url,
    exampleSentences: examples.map((example) => ({ hanzi: example.hanzi, pinyin: example.pinyin, urdu: example.urdu })),
    hskTag: item.hsk_level != null ? 'HSK ' + item.hsk_level : 'HSK 1',
    topicTags: await topics('vocabulary_topics', 'vocabulary_id', item.id)
  };
}

function vocabularyListItem(item, examples, topicNames) {
  return {
    id: item.id,
    hanzi: item.hanzi,
    pinyin: item.pinyin,
    tone: num(item.tone),
    urduTranslation: item.urdu_translation,
    romanUrdu: text(item.roman_urdu),
    partOfSpeech: text(item.part_of_speech),
    hskLevel: num(item.hsk_level, 1),
    topics: topicNames,
    examples: examples.map((example) => ({ hanzi: example.hanzi, pinyin: example.pinyin, urdu: example.urdu })),
    audioMaleUrl: item.audio_male_url,
    audioFemaleUrl: item.audio_female_url,
    illustrationUrl: item.illustration_url
  };
}

async function topics(table, column, id) {
  const rows = await query(`SELECT topic FROM ${table} WHERE ${column} = $1`, [id]);
  return rows.map((row) => row.topic);
}

async function objectives(unitId) {
  const rows = await query('SELECT objective FROM unit_objectives WHERE unit_id = $1', [unitId]);
  return rows.map((row) => row.objective);
}

function localized(value) {
  return { ur: value, en: value };
}

function dataOf(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function firstText(data, fields) {
  for (const field of fields) {
    const value = data[field];
    if (value != null && String(value).trim() !== '') return String(value);
  }
  return null;
}

function stringList(data, field) {
  return Array.isArray(data[field]) ? data[field].map(String) : null;
}

function extractPrompt(data, lesson) {
  let ur = firstText(data, ['promptUr', 'prompt']);
  let en = firstText(data, ['promptEn', 'prompt', 'instructionText']);
  if (ur == null && en == null) {
    ur = lesson.urdu_title;
    en = lesson.instruction_text;
  }
  return { ur: text(ur), en: text(en, ur) };
}

function extractGloss(data) {
  const gloss = data.gloss;
  if (gloss == null) {
    const urdu = firstText(data, ['urdu', 'urduTranslation']);
    return urdu ? [{ ur: urdu, en: urdu }] : null;
  }
  if (Array.isArray(gloss)) {
    return gloss.map((node) => ({ ur: node.ur || String(node), en: node.en || node.ur || String(node) }));
  }
  return [{ ur: String(gloss), en: String(gloss) }];
}

function extractHint(data) {
  const hint = data.hint;
  if (hint == null) return null;
  if (typeof hint === 'object') return { ur: hint.ur || '', en: hint.en || hint.ur || '' };
  return { ur: String(hint), en: String(hint) };
}

function mobileLessonType(value) {
  const type = String(value || '').toUpperCase();
  if (type === 'CHECKPOINT') return 'checkpoint';
  if (type === 'REVIEW') return 'review';
  return 'normal';
}

function teachThenQuiz(exercises) {
  const teaches = exercises.filter((exercise) => isTeach(exercise.exercise_type));
  const quizzes = exercises.filter((exercise) => !isTeach(exercise.exercise_type));
  if (!teaches.length || !quizzes.length) return exercises;
  return teaches.concat(quizzes);
}

function isTeach(type) {
  const value = String(type || '').trim().toUpperCase();
  return value === 'TEACH_FRAME' || value === 'TEACH';
}

function mobileExerciseType(type) {
  switch (String(type || '').toUpperCase()) {
    case 'TEACH_FRAME':
    case 'TEACH': return 'teach';
    case 'PICTURE_MATCH':
    case 'PIC': return 'pic';
    case 'LISTENING_CHOICE':
    case 'LISTEN': return 'listen';
    case 'TONE_DRILL':
    case 'TONE': return 'tone';
    case 'TAP_TO_BUILD':
    case 'BUILD': return 'build';
    case 'FILL_IN_THE_BLANK':
    case 'FILL': return 'fill';
    default: return String(type || 'teach').toLowerCase();
  }
}

module.exports = router;
