const { query } = require('./db');
const { isLive, num } = require('./util');

let cache = null;
let loading = null;

function invalidateCatalog() {
  cache = null;
  loading = null;
}

async function getCatalog() {
  if (cache) return cache;
  if (!loading) {
    loading = loadCatalog().then((loaded) => {
      cache = loaded;
      loading = null;
      return loaded;
    }).catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

async function loadCatalog() {
  const [courses, units, lessons, exercises, vocabulary, examples, topics] = await Promise.all([
    query('SELECT * FROM courses ORDER BY created_at ASC NULLS LAST'),
    query('SELECT * FROM units ORDER BY unit_number ASC'),
    query('SELECT * FROM lessons ORDER BY lesson_number ASC'),
    query('SELECT * FROM exercises ORDER BY exercise_order ASC'),
    query('SELECT * FROM vocabulary ORDER BY created_at DESC NULLS LAST'),
    query('SELECT * FROM example_sentences'),
    query('SELECT vocabulary_id, topic FROM vocabulary_topics')
  ]);

  const liveCourses = courses.filter((row) => isLive(row.status));
  const unitsByCourse = new Map();
  for (const unit of units) {
    if (!isLive(unit.status)) continue;
    if (!unitsByCourse.has(unit.course_id)) unitsByCourse.set(unit.course_id, []);
    unitsByCourse.get(unit.course_id).push(unit);
  }
  const lessonsByUnit = new Map();
  for (const lesson of lessons) {
    if (!isLive(lesson.status)) continue;
    if (!lessonsByUnit.has(lesson.unit_id)) lessonsByUnit.set(lesson.unit_id, []);
    lessonsByUnit.get(lesson.unit_id).push(lesson);
  }
  const lessonsById = new Map();
  for (const lesson of lessons) {
    if (isLive(lesson.status)) lessonsById.set(lesson.id, lesson);
  }
  const unitsById = new Map();
  for (const unit of units) {
    if (isLive(unit.status)) unitsById.set(unit.id, unit);
  }
  const coursesById = new Map(liveCourses.map((course) => [course.id, course]));
  const exercisesByLesson = new Map();
  for (const exercise of exercises) {
    if (!exercisesByLesson.has(exercise.lesson_id)) exercisesByLesson.set(exercise.lesson_id, []);
    exercisesByLesson.get(exercise.lesson_id).push(exercise);
  }
  const examplesByWord = new Map();
  for (const example of examples) {
    if (!examplesByWord.has(example.vocabulary_id)) examplesByWord.set(example.vocabulary_id, []);
    examplesByWord.get(example.vocabulary_id).push(example);
  }
  const topicsByWord = new Map();
  for (const topic of topics) {
    if (!topicsByWord.has(topic.vocabulary_id)) topicsByWord.set(topic.vocabulary_id, []);
    topicsByWord.get(topic.vocabulary_id).push(topic.topic);
  }
  const wordCountByCourse = new Map();
  for (const [courseId, courseUnits] of unitsByCourse) {
    let total = 0;
    for (const unit of courseUnits) {
      for (const lesson of lessonsByUnit.get(unit.id) || []) {
        total += num(lesson.words_count);
      }
    }
    wordCountByCourse.set(courseId, total);
  }

  return {
    courses: liveCourses,
    coursesById,
    unitsByCourse,
    unitsById,
    lessonsByUnit,
    lessonsById,
    exercisesByLesson,
    vocabulary,
    examplesByWord,
    topicsByWord,
    wordCountByCourse
  };
}

function courseTotals(catalog, courseId) {
  return {
    totalUnits: (catalog.unitsByCourse.get(courseId) || []).length,
    totalWords: catalog.wordCountByCourse.get(courseId) || 0
  };
}

module.exports = { getCatalog, invalidateCatalog, courseTotals };
