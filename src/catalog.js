const { query } = require('./db');
const { isLive, num } = require('./util');

const TABLES = {
  courses: 'SELECT * FROM courses ORDER BY created_at ASC NULLS LAST',
  units: 'SELECT * FROM units ORDER BY unit_number ASC',
  lessons: 'SELECT * FROM lessons ORDER BY lesson_number ASC',
  exercises: 'SELECT * FROM exercises ORDER BY exercise_order ASC',
  vocabulary: 'SELECT * FROM vocabulary ORDER BY created_at DESC NULLS LAST',
  examples: 'SELECT * FROM example_sentences',
  vocabulary_topics: 'SELECT vocabulary_id, topic FROM vocabulary_topics',
  unit_topics: 'SELECT unit_id, topic FROM unit_topics',
  unit_objectives: 'SELECT unit_id, objective FROM unit_objectives'
};

const rows = {};
const loading = {};
let assembled;
let assembling;

function invalidateCatalog() {
  Object.keys(TABLES).forEach((name) => {
    rows[name] = null;
    loading[name] = null;
  });
  assembled = null;
  assembling = null;
}

async function cachedTable(name) {
  if (rows[name]) return rows[name];
  if (!loading[name]) {
    loading[name] = query(TABLES[name]).then((data) => {
      rows[name] = data;
      loading[name] = null;
      return data;
    }).catch((error) => {
      loading[name] = null;
      throw error;
    });
  }
  return loading[name];
}

function group(list, key) {
  const map = new Map();
  for (const row of list) {
    const id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

function values(list, key, valueKey) {
  const map = new Map();
  for (const row of list) {
    const id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row[valueKey]);
  }
  return map;
}

async function getCatalog() {
  if (assembled) return assembled;
  if (!assembling) {
    assembling = Promise.all([
      cachedTable('courses'),
      cachedTable('units'),
      cachedTable('lessons'),
      cachedTable('exercises'),
      cachedTable('vocabulary'),
      cachedTable('examples'),
      cachedTable('vocabulary_topics')
    ]).then(([courses, units, lessons, exercises, vocabulary, examples, vocabTopics]) => {
      const liveCourses = courses.filter((row) => isLive(row.status));
      const allUnitsByCourse = group(units, 'course_id');
      const liveUnitsByCourse = new Map();
      for (const [courseId, courseUnits] of allUnitsByCourse) {
        liveUnitsByCourse.set(courseId, courseUnits.filter((row) => isLive(row.status)));
      }
      const allLessonsByUnit = group(lessons, 'unit_id');
      const liveLessonsByUnit = new Map();
      for (const [unitId, unitLessons] of allLessonsByUnit) {
        liveLessonsByUnit.set(unitId, unitLessons.filter((row) => isLive(row.status)));
      }
      const wordCountByCourse = new Map();
      for (const [courseId, courseUnits] of liveUnitsByCourse) {
        let total = 0;
        for (const unit of courseUnits) {
          for (const lesson of liveLessonsByUnit.get(unit.id) || []) total += num(lesson.words_count);
        }
        wordCountByCourse.set(courseId, total);
      }
      assembled = {
        courses: liveCourses,
        allCourses: courses,
        coursesById: new Map(liveCourses.map((course) => [course.id, course])),
        allCoursesById: new Map(courses.map((course) => [course.id, course])),
        unitsByCourse: liveUnitsByCourse,
        allUnitsByCourse,
        unitsById: new Map(units.filter((row) => isLive(row.status)).map((unit) => [unit.id, unit])),
        allUnitsById: new Map(units.map((unit) => [unit.id, unit])),
        lessonsByUnit: liveLessonsByUnit,
        allLessonsByUnit,
        lessonsById: new Map(lessons.filter((row) => isLive(row.status)).map((lesson) => [lesson.id, lesson])),
        allLessonsById: new Map(lessons.map((lesson) => [lesson.id, lesson])),
        exercisesByLesson: group(exercises, 'lesson_id'),
        allExercisesById: new Map(exercises.map((exercise) => [exercise.id, exercise])),
        vocabulary,
        vocabularyById: new Map(vocabulary.map((item) => [item.id, item])),
        examplesByWord: group(examples, 'vocabulary_id'),
        topicsByWord: values(vocabTopics, 'vocabulary_id', 'topic'),
        wordCountByCourse
      };
      assembling = null;
      return assembled;
    }).catch((error) => {
      assembling = null;
      throw error;
    });
  }
  return assembling;
}

function courseTotals(catalog, courseId) {
  return {
    totalUnits: (catalog.unitsByCourse.get(courseId) || []).length,
    totalWords: catalog.wordCountByCourse.get(courseId) || 0
  };
}

module.exports = { getCatalog, cachedTable, invalidateCatalog, courseTotals };
