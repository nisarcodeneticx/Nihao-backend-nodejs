const express = require('express');
const { query, queryOne, withTx } = require('./db');
const { ok, iso, text, num, pageOf, badRequest, notFound, blankToNull } = require('./util');
const { requireAdmin } = require('./auth');
const { invalidateCatalog } = require('./catalog');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) invalidateCatalog();
    return send(body);
  };
  next();
});

const COURSE_SORT = { createdAt: 'created_at', name: 'name', status: 'status', hskLevel: 'hsk_level', updatedAt: 'updated_at' };

router.get('/courses', async (req, res, next) => {
  try {
    const page = Number(req.query.page || 0);
    const size = Number(req.query.size || 20);
    const sortColumn = COURSE_SORT[req.query.sortBy] || 'created_at';
    const direction = String(req.query.sortDirection || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const params = [];
    let where = 'WHERE 1=1';
    if (blankToNull(req.query.search)) {
      params.push('%' + req.query.search.trim() + '%');
      where += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }
    if (blankToNull(req.query.status)) {
      params.push(req.query.status.trim());
      where += ` AND status = $${params.length}`;
    }
    const total = await queryOne(`SELECT COUNT(*)::int AS count FROM courses ${where}`, params);
    params.push(size, page * size);
    const rows = await query(
      `SELECT * FROM courses ${where} ORDER BY ${sortColumn} ${direction} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const vocab = await queryOne('SELECT COUNT(*)::int AS count FROM vocabulary');
    const content = [];
    for (const course of rows) content.push(await courseResponse(course, false, vocab.count));
    res.json(ok(pageOf(content, total.count, page, size)));
  } catch (error) { next(error); }
});

router.get('/courses/:id', async (req, res, next) => {
  try {
    const course = await mustCourse(req.params.id);
    res.json(ok(await courseResponse(course, true)));
  } catch (error) { next(error); }
});

router.post('/courses', async (req, res, next) => {
  try {
    validateCourse(req.body);
    const status = text(req.body.status, 'PUBLISHED').toUpperCase();
    const now = new Date();
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO courses (id, name, hsk_level, description, difficulty, cover_image_url, status, created_by, created_at, updated_at, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,
      [id, req.body.name, req.body.hskLevel, req.body.description, text(req.body.difficulty, 'Beginner'), req.body.coverImageUrl || null, status, req.user.id, now, status === 'PUBLISHED' ? now : null]
    );
    res.json(ok('Course created', await courseResponse(await mustCourse(id), false)));
  } catch (error) { next(error); }
});

router.put('/courses/:id', async (req, res, next) => {
  try {
    validateCourse(req.body);
    const course = await mustCourse(req.params.id);
    let publishedAt = course.published_at;
    let status = course.status;
    if (req.body.status != null) {
      status = String(req.body.status).toUpperCase();
      if (status === 'PUBLISHED' && !publishedAt) publishedAt = new Date();
    }
    await query(
      `UPDATE courses SET name=$2, hsk_level=$3, description=$4, difficulty=COALESCE($5, difficulty),
        cover_image_url=COALESCE($6, cover_image_url), status=$7, published_at=$8, updated_at=NOW() WHERE id=$1`,
      [course.id, req.body.name, req.body.hskLevel, req.body.description, req.body.difficulty || null, req.body.coverImageUrl || null, status, publishedAt]
    );
    res.json(ok('Course updated', await courseResponse(await mustCourse(course.id), false)));
  } catch (error) { next(error); }
});

router.patch('/courses/:id/status', async (req, res, next) => {
  try {
    if (!text(req.query.status)) throw badRequest('Status is required');
    const course = await mustCourse(req.params.id);
    const status = String(req.query.status).toUpperCase();
    const publishedAt = status === 'PUBLISHED' && !course.published_at ? new Date() : course.published_at;
    await query('UPDATE courses SET status=$2, published_at=$3, updated_at=NOW() WHERE id=$1', [course.id, status, publishedAt]);
    res.json(ok('Status updated', await courseResponse(await mustCourse(course.id), false)));
  } catch (error) { next(error); }
});

router.delete('/courses/:id', async (req, res, next) => {
  try {
    await mustCourse(req.params.id);
    await query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    res.json(ok('Course deleted', null));
  } catch (error) { next(error); }
});

router.get('/units/course/:courseId', async (req, res, next) => {
  try {
    const course = await queryOne('SELECT id FROM courses WHERE id = $1', [req.params.courseId]);
    if (!course) return res.json(ok([]));
    const units = await query('SELECT * FROM units WHERE course_id = $1 ORDER BY unit_number ASC', [req.params.courseId]);
    res.json(ok(await Promise.all(units.map((unit) => unitResponse(unit, false)))));
  } catch (error) { next(error); }
});

router.patch('/units/reorder', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body) ? req.body : [];
    for (let i = 0; i < ids.length; i += 1) {
      await mustUnit(ids[i]);
      await query('UPDATE units SET unit_number = $2, updated_at = NOW() WHERE id = $1', [ids[i], i + 1]);
    }
    if (!ids.length) return res.json(ok('Units reordered', []));
    const first = await mustUnit(ids[0]);
    const units = await query('SELECT * FROM units WHERE course_id = $1 ORDER BY unit_number ASC', [first.course_id]);
    res.json(ok('Units reordered', await Promise.all(units.map((unit) => unitResponse(unit, false)))));
  } catch (error) { next(error); }
});

router.get('/units/:id', async (req, res, next) => {
  try { res.json(ok(await unitResponse(await mustUnit(req.params.id), true))); } catch (error) { next(error); }
});

router.post('/units/course/:courseId', async (req, res, next) => {
  try {
    const course = await mustCourse(req.params.courseId);
    if (!text(req.body.urduTitle) || !text(req.body.hanziTitle)) throw badRequest('Validation failed');
    const count = await queryOne('SELECT COUNT(*)::int AS count FROM units WHERE course_id = $1', [course.id]);
    const status = text(req.body.status, 'PUBLISHED').toUpperCase();
    const now = new Date();
    const id = crypto.randomUUID();
    await withTx(async (client) => {
      await query(
        `INSERT INTO units (id, course_id, unit_number, urdu_title, hanzi_title, grammar_point, hsk_level, estimated_time, difficulty, status, version, published_at, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [id, course.id, req.body.unitNumber || count.count + 1, req.body.urduTitle, req.body.hanziTitle, req.body.grammarPoint || null, text(req.body.hskLevel, course.hsk_level), num(req.body.estimatedTime, 20), text(req.body.difficulty, 'Easy'), status, num(req.body.version, 1), status === 'PUBLISHED' ? now : null, req.user.id, now],
        client
      );
      await replaceStrings(client, 'unit_topics', 'unit_id', 'topic', id, req.body.topics);
      await replaceStrings(client, 'unit_objectives', 'unit_id', 'objective', id, req.body.learningObjectives);
    });
    res.json(ok('Unit created', await unitResponse(await mustUnit(id), false)));
  } catch (error) { next(error); }
});

router.put('/units/:id', async (req, res, next) => {
  try {
    const unit = await mustUnit(req.params.id);
    if (!text(req.body.urduTitle) || !text(req.body.hanziTitle)) throw badRequest('Validation failed');
    let publishedAt = unit.published_at;
    const status = req.body.status != null ? String(req.body.status).toUpperCase() : unit.status;
    if (status === 'PUBLISHED' && !publishedAt) publishedAt = new Date();
    await withTx(async (client) => {
      await query(
        `UPDATE units SET unit_number=COALESCE($2, unit_number), urdu_title=$3, hanzi_title=$4, grammar_point=COALESCE($5, grammar_point),
          hsk_level=COALESCE($6, hsk_level), estimated_time=COALESCE($7, estimated_time), difficulty=COALESCE($8, difficulty),
          status=$9, version=COALESCE($10, version), published_at=$11, updated_at=NOW() WHERE id=$1`,
        [unit.id, req.body.unitNumber || null, req.body.urduTitle, req.body.hanziTitle, req.body.grammarPoint || null, req.body.hskLevel || null, req.body.estimatedTime || null, req.body.difficulty || null, status, req.body.version || null, publishedAt],
        client
      );
      if (req.body.topics) await replaceStrings(client, 'unit_topics', 'unit_id', 'topic', unit.id, req.body.topics);
      if (req.body.learningObjectives) await replaceStrings(client, 'unit_objectives', 'unit_id', 'objective', unit.id, req.body.learningObjectives);
    });
    res.json(ok('Unit updated', await unitResponse(await mustUnit(unit.id), false)));
  } catch (error) { next(error); }
});

router.delete('/units/:id', async (req, res, next) => {
  try {
    await mustUnit(req.params.id);
    await query('DELETE FROM units WHERE id = $1', [req.params.id]);
    res.json(ok('Unit deleted', null));
  } catch (error) { next(error); }
});

router.get('/lessons/unit/:unitId', async (req, res, next) => {
  try {
    const unit = await queryOne('SELECT id FROM units WHERE id = $1', [req.params.unitId]);
    if (!unit) return res.json(ok([]));
    const lessons = await query('SELECT * FROM lessons WHERE unit_id = $1 ORDER BY lesson_number ASC', [req.params.unitId]);
    res.json(ok(lessons.map((lesson) => lessonResponse(lesson, []))));
  } catch (error) { next(error); }
});

router.get('/lessons/:id', async (req, res, next) => {
  try {
    const lesson = await mustLesson(req.params.id);
    const exercises = await query('SELECT * FROM exercises WHERE lesson_id = $1 ORDER BY exercise_order ASC', [lesson.id]);
    res.json(ok(lessonResponse(lesson, exercises)));
  } catch (error) { next(error); }
});

router.post('/lessons/unit/:unitId', async (req, res, next) => {
  try {
    await mustUnit(req.params.unitId);
    if (!text(req.body.lessonType) || !text(req.body.urduTitle)) throw badRequest('Validation failed');
    const count = await queryOne('SELECT COUNT(*)::int AS count FROM lessons WHERE unit_id = $1', [req.params.unitId]);
    const id = crypto.randomUUID();
    const now = new Date();
    await query(
      `INSERT INTO lessons (id, unit_id, lesson_number, lesson_type, urdu_title, instruction_text, difficulty, crowns, status, exercises_count, words_count, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [id, req.params.unitId, req.body.lessonNumber || count.count + 1, storedLessonType(req.body.lessonType), req.body.urduTitle, text(req.body.instructionText), text(req.body.difficulty, 'Easy'), num(req.body.crowns, 3), text(req.body.status, 'PUBLISHED').toUpperCase(), num(req.body.exercisesCount), num(req.body.wordsCount), req.user.id, now]
    );
    res.json(ok('Lesson created', lessonResponse(await mustLesson(id), [])));
  } catch (error) { next(error); }
});

router.put('/lessons/:id', async (req, res, next) => {
  try {
    const lesson = await mustLesson(req.params.id);
    await query(
      `UPDATE lessons SET lesson_number=COALESCE($2, lesson_number), lesson_type=$3, urdu_title=$4, instruction_text=COALESCE($5, instruction_text),
        difficulty=COALESCE($6, difficulty), crowns=COALESCE($7, crowns), status=COALESCE($8, status), exercises_count=COALESCE($9, exercises_count),
        words_count=COALESCE($10, words_count), updated_at=NOW() WHERE id=$1`,
      [lesson.id, req.body.lessonNumber || null, storedLessonType(req.body.lessonType || lesson.lesson_type), req.body.urduTitle || lesson.urdu_title, req.body.instructionText || null, req.body.difficulty || null, req.body.crowns || null, req.body.status ? String(req.body.status).toUpperCase() : null, req.body.exercisesCount || null, req.body.wordsCount || null]
    );
    res.json(ok('Lesson updated', lessonResponse(await mustLesson(lesson.id), [])));
  } catch (error) { next(error); }
});

router.delete('/lessons/:id', async (req, res, next) => {
  try {
    await mustLesson(req.params.id);
    await query('DELETE FROM lessons WHERE id = $1', [req.params.id]);
    res.json(ok('Lesson deleted', null));
  } catch (error) { next(error); }
});

router.get('/exercises', async (req, res, next) => {
  try {
    const page = Number(req.query.page || 0);
    const size = Number(req.query.size || 20);
    const params = [];
    let sql = `SELECT e.*, l.urdu_title AS lesson_title, u.urdu_title AS unit_title, c.name AS course_name
               FROM exercises e JOIN lessons l ON l.id = e.lesson_id JOIN units u ON u.id = l.unit_id JOIN courses c ON c.id = u.course_id`;
    if (blankToNull(req.query.lessonId)) {
      params.push(req.query.lessonId);
      sql += ' WHERE e.lesson_id = $1';
    }
    sql += ' ORDER BY e.exercise_order ASC';
    const rows = await query(sql, params);
    const slice = rows.slice(page * size, page * size + size).map((row) => ({
      id: row.id, lessonId: row.lesson_id, lessonTitle: row.lesson_title, unitTitle: row.unit_title,
      courseName: row.course_name, exerciseType: row.exercise_type, exerciseOrder: row.exercise_order
    }));
    res.json(ok(pageOf(slice, rows.length, page, size)));
  } catch (error) { next(error); }
});

router.get('/exercises/lesson/:lessonId', async (req, res, next) => {
  try {
    await mustLesson(req.params.lessonId);
    const rows = await query('SELECT * FROM exercises WHERE lesson_id = $1 ORDER BY exercise_order ASC', [req.params.lessonId]);
    res.json(ok(rows.map(exerciseResponse)));
  } catch (error) { next(error); }
});

router.get('/exercises/:id', async (req, res, next) => {
  try { res.json(ok(exerciseResponse(await mustExercise(req.params.id)))); } catch (error) { next(error); }
});

router.post('/exercises/lesson/:lessonId', async (req, res, next) => {
  try {
    await mustLesson(req.params.lessonId);
    if (!text(req.body.exerciseType) || req.body.exerciseData == null) throw badRequest('Validation failed');
    const count = await queryOne('SELECT COUNT(*)::int AS count FROM exercises WHERE lesson_id = $1', [req.params.lessonId]);
    const id = crypto.randomUUID();
    const now = new Date();
    await query(
      `INSERT INTO exercises (id, lesson_id, exercise_type, exercise_data, exercise_order, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$7)`,
      [id, req.params.lessonId, req.body.exerciseType, JSON.stringify(req.body.exerciseData), req.body.exerciseOrder || count.count + 1, req.user.id, now]
    );
    res.json(ok('Exercise created', exerciseResponse(await mustExercise(id))));
  } catch (error) { next(error); }
});

router.put('/exercises/:id', async (req, res, next) => {
  try {
    const exercise = await mustExercise(req.params.id);
    await query(
      `UPDATE exercises SET exercise_type=$2, exercise_data=$3::jsonb, exercise_order=COALESCE($4, exercise_order), updated_at=NOW() WHERE id=$1`,
      [exercise.id, req.body.exerciseType || exercise.exercise_type, JSON.stringify(req.body.exerciseData || exercise.exercise_data), req.body.exerciseOrder || null]
    );
    res.json(ok('Exercise updated', exerciseResponse(await mustExercise(exercise.id))));
  } catch (error) { next(error); }
});

router.delete('/exercises/:id', async (req, res, next) => {
  try {
    await mustExercise(req.params.id);
    await query('DELETE FROM exercises WHERE id = $1', [req.params.id]);
    res.json(ok('Exercise deleted', null));
  } catch (error) { next(error); }
});

router.get('/vocabulary', async (req, res, next) => {
  try {
    const page = Number(req.query.page || 0);
    const size = Number(req.query.size || 20);
    const { where, params } = vocabFilter(req.query);
    const total = await queryOne(`SELECT COUNT(*)::int AS count FROM vocabulary ${where}`, params);
    const rows = await query(
      `SELECT * FROM vocabulary ${where} ORDER BY created_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params.concat([size, page * size])
    );
    const ids = rows.map((row) => row.id);
    const [exampleRows, topicRows] = ids.length
      ? await Promise.all([
        query('SELECT * FROM example_sentences WHERE vocabulary_id = ANY($1::text[]) ORDER BY created_at ASC', [ids]),
        query('SELECT vocabulary_id, topic FROM vocabulary_topics WHERE vocabulary_id = ANY($1::text[])', [ids])
      ])
      : [[], []];
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
    const content = rows.map((item) => vocabularyListResponse(
      item,
      examplesByWord.get(item.id) || [],
      topicsByWord.get(item.id) || []
    ));
    res.json(ok(pageOf(content, total.count, page, size)));
  } catch (error) { next(error); }
});

router.post('/vocabulary/bulk', async (req, res, next) => {
  try {
    const created = [];
    for (const item of req.body || []) created.push(await createVocabulary(item, req.user.id));
    res.json(ok('Vocabulary imported', created));
  } catch (error) { next(error); }
});

router.get('/vocabulary/:id', async (req, res, next) => {
  try { res.json(ok(await vocabularyResponse(await mustVocab(req.params.id)))); } catch (error) { next(error); }
});

router.post('/vocabulary', async (req, res, next) => {
  try { res.json(ok('Vocabulary created', await createVocabulary(req.body, req.user.id))); } catch (error) { next(error); }
});

router.put('/vocabulary/:id', async (req, res, next) => {
  try {
    const item = await mustVocab(req.params.id);
    validateVocab(req.body);
    await withTx(async (client) => {
      await query(
        `UPDATE vocabulary SET hanzi=$2, pinyin=$3, tone=$4, urdu_translation=$5, roman_urdu=$6, literal_gloss=$7, part_of_speech=$8,
          hsk_level=$9, frequency=$10, stroke_count=$11, radical=$12, audio_male_url=$13, audio_female_url=$14, illustration_url=$15, updated_at=NOW()
         WHERE id=$1`,
        vocabValues(item.id, req.body),
        client
      );
      if (req.body.topics) await replaceStrings(client, 'vocabulary_topics', 'vocabulary_id', 'topic', item.id, req.body.topics);
      if (req.body.examples) {
        await query('DELETE FROM example_sentences WHERE vocabulary_id = $1', [item.id], client);
        await insertExamples(client, item.id, req.body.examples);
      }
    });
    res.json(ok('Vocabulary updated', await vocabularyResponse(await mustVocab(item.id))));
  } catch (error) { next(error); }
});

router.delete('/vocabulary/:id', async (req, res, next) => {
  try {
    await mustVocab(req.params.id);
    await query('DELETE FROM vocabulary WHERE id = $1', [req.params.id]);
    res.json(ok('Vocabulary deleted', null));
  } catch (error) { next(error); }
});

router.get('/users', async (req, res, next) => {
  try {
    const page = Number(req.query.page || 0);
    const size = Number(req.query.size || 20);
    const params = [];
    let where = 'WHERE 1=1';
    if (blankToNull(req.query.search)) {
      params.push('%' + req.query.search.trim() + '%');
      where += ` AND (email ILIKE $${params.length} OR username ILIKE $${params.length} OR full_name ILIKE $${params.length})`;
    }
    if (blankToNull(req.query.status)) {
      params.push(req.query.status.trim());
      where += ` AND status = $${params.length}`;
    }
    const total = await queryOne(`SELECT COUNT(*)::int AS count FROM users ${where}`, params);
    const rows = await query(
      `SELECT * FROM users ${where} ORDER BY created_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params.concat([size, page * size])
    );
    res.json(ok(pageOf(rows.map(userResponse), total.count, page, size)));
  } catch (error) { next(error); }
});

router.get('/users/:id', async (req, res, next) => {
  try { res.json(ok(userResponse(await mustUser(req.params.id)))); } catch (error) { next(error); }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const user = await mustUser(req.params.id);
    await query(
      `UPDATE users SET full_name = COALESCE($2, full_name), role = COALESCE($3, role), status = COALESCE($4, status), avatar_url = COALESCE($5, avatar_url), updated_at = NOW() WHERE id = $1`,
      [user.id, req.body.fullName ?? null, req.body.role ? String(req.body.role).toUpperCase() : null, req.body.status ? String(req.body.status).toUpperCase() : null, req.body.avatarUrl ?? null]
    );
    res.json(ok('User updated', userResponse(await mustUser(user.id))));
  } catch (error) { next(error); }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await mustUser(req.params.id);
    if (String(user.role).toUpperCase() === 'ADMIN') throw badRequest('Cannot delete admin user');
    await query('DELETE FROM users WHERE id = $1', [user.id]);
    res.json(ok('User deleted', null));
  } catch (error) { next(error); }
});

router.patch('/users/:id/ban', async (req, res, next) => {
  try {
    await mustUser(req.params.id);
    await query(`UPDATE users SET status = 'BANNED', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json(ok('User banned', userResponse(await mustUser(req.params.id))));
  } catch (error) { next(error); }
});

router.patch('/users/:id/premium', async (req, res, next) => {
  try {
    res.json(ok('Premium granted', userResponse(await mustUser(req.params.id))));
  } catch (error) { next(error); }
});

function validateCourse(body) {
  const errors = {};
  if (!text(body.name)) errors.name = 'Name is required';
  if (!text(body.hskLevel)) errors.hskLevel = 'HSK level is required';
  if (!text(body.description) || String(body.description).trim().length < 10) errors.description = 'Description must be at least 10 characters';
  if (Object.keys(errors).length) throw badRequest(Object.values(errors).join('; '), errors);
}

function validateVocab(body) {
  if (!text(body.hanzi) || !text(body.pinyin) || !text(body.urduTranslation)) throw badRequest('Validation failed');
}

async function createVocabulary(body, userId) {
  validateVocab(body);
  const id = crypto.randomUUID();
  const now = new Date();
  await withTx(async (client) => {
    await query(
      `INSERT INTO vocabulary (id, hanzi, pinyin, tone, urdu_translation, roman_urdu, literal_gloss, part_of_speech, hsk_level, frequency, stroke_count, radical, audio_male_url, audio_female_url, illustration_url, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [id, ...vocabValues(null, body).slice(1), userId, now],
      client
    );
    await replaceStrings(client, 'vocabulary_topics', 'vocabulary_id', 'topic', id, body.topics || []);
    await insertExamples(client, id, body.examples || []);
  });
  return vocabularyResponse(await mustVocab(id));
}

function vocabValues(id, body) {
  return [id, body.hanzi, body.pinyin, body.tone ?? null, body.urduTranslation, body.romanUrdu || null, body.literalGloss || null, body.partOfSpeech || null, body.hskLevel ?? null, body.frequency ?? null, body.strokeCount ?? null, body.radical || null, body.audioMaleUrl || null, body.audioFemaleUrl || null, body.illustrationUrl || null];
}

async function insertExamples(client, vocabularyId, examples) {
  for (const example of examples) {
    await query(
      'INSERT INTO example_sentences (id, vocabulary_id, hanzi, pinyin, urdu, created_at) VALUES ($1,$2,$3,$4,$5,NOW())',
      [crypto.randomUUID(), vocabularyId, example.hanzi, example.pinyin, example.urdu],
      client
    );
  }
}

async function replaceStrings(client, table, idColumn, valueColumn, id, values) {
  await query(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id], client);
  for (const value of values || []) {
    await query(`INSERT INTO ${table} (${idColumn}, ${valueColumn}) VALUES ($1,$2)`, [id, value], client);
  }
}

async function courseResponse(course, includeChildren, vocabCount) {
  const units = await queryOne('SELECT COUNT(*)::int AS count FROM units WHERE course_id = $1', [course.id]);
  const vocabulary = vocabCount == null ? (await queryOne('SELECT COUNT(*)::int AS count FROM vocabulary')).count : vocabCount;
  const body = {
    id: course.id, name: course.name, hskLevel: course.hsk_level, description: course.description, difficulty: course.difficulty,
    coverImageUrl: course.cover_image_url, status: course.status, units: units.count, vocabulary, createdBy: course.created_by,
    createdAt: iso(course.created_at), updatedAt: iso(course.updated_at), publishedAt: iso(course.published_at)
  };
  if (includeChildren) {
    const rows = await query('SELECT * FROM units WHERE course_id = $1 ORDER BY unit_number ASC', [course.id]);
    body.unitsList = await Promise.all(rows.map((unit) => unitResponse(unit, true)));
  }
  return body;
}

async function unitResponse(unit, includeLessons) {
  const body = {
    id: unit.id, unitNumber: num(unit.unit_number), urduTitle: unit.urdu_title, hanziTitle: unit.hanzi_title,
    grammarPoint: unit.grammar_point, hskLevel: unit.hsk_level, topics: await listColumn('unit_topics', 'unit_id', 'topic', unit.id),
    estimatedTime: num(unit.estimated_time), difficulty: unit.difficulty, learningObjectives: await listColumn('unit_objectives', 'unit_id', 'objective', unit.id),
    status: unit.status, version: num(unit.version, 1), publishedAt: iso(unit.published_at), createdBy: unit.created_by,
    createdAt: iso(unit.created_at), updatedAt: iso(unit.updated_at)
  };
  if (includeLessons) {
    const lessons = await query('SELECT * FROM lessons WHERE unit_id = $1 ORDER BY lesson_number ASC', [unit.id]);
    body.lessons = [];
    for (const lesson of lessons) {
      const exercises = await query('SELECT * FROM exercises WHERE lesson_id = $1 ORDER BY exercise_order ASC', [lesson.id]);
      body.lessons.push(lessonResponse(lesson, exercises));
    }
  }
  return body;
}

function lessonResponse(lesson, exercises) {
  return {
    id: lesson.id, lessonNumber: num(lesson.lesson_number), lessonType: lesson.lesson_type, urduTitle: lesson.urdu_title,
    instructionText: lesson.instruction_text, difficulty: lesson.difficulty, crowns: num(lesson.crowns), status: lesson.status,
    exercisesCount: num(lesson.exercises_count), wordsCount: num(lesson.words_count), createdBy: lesson.created_by,
    exercises: exercises.map(exerciseResponse), createdAt: iso(lesson.created_at), updatedAt: iso(lesson.updated_at)
  };
}

function exerciseResponse(exercise) {
  return {
    id: exercise.id, exerciseType: exercise.exercise_type, exerciseData: typeof exercise.exercise_data === 'string' ? JSON.parse(exercise.exercise_data) : exercise.exercise_data,
    exerciseOrder: num(exercise.exercise_order), createdBy: exercise.created_by, createdAt: iso(exercise.created_at), updatedAt: iso(exercise.updated_at)
  };
}

async function vocabularyResponse(item) {
  const examples = await query('SELECT * FROM example_sentences WHERE vocabulary_id = $1 ORDER BY created_at ASC', [item.id]);
  return vocabularyListResponse(item, examples, await listColumn('vocabulary_topics', 'vocabulary_id', 'topic', item.id));
}

function vocabularyListResponse(item, examples, topics) {
  return {
    id: item.id, hanzi: item.hanzi, pinyin: item.pinyin, tone: num(item.tone), urduTranslation: item.urdu_translation,
    romanUrdu: item.roman_urdu, literalGloss: item.literal_gloss, partOfSpeech: item.part_of_speech, hskLevel: num(item.hsk_level, 1),
    topics, frequency: num(item.frequency),
    strokeCount: item.stroke_count, radical: item.radical, audioMaleUrl: item.audio_male_url, audioFemaleUrl: item.audio_female_url,
    illustrationUrl: item.illustration_url, examples: examples.map((example) => ({ id: example.id, hanzi: example.hanzi, pinyin: example.pinyin, urdu: example.urdu, createdAt: iso(example.created_at) })),
    createdBy: item.created_by, createdAt: iso(item.created_at), updatedAt: iso(item.updated_at)
  };
}

function userResponse(user) {
  return {
    id: user.id, username: user.username, email: user.email, fullName: user.full_name, role: user.role, status: user.status,
    avatarUrl: user.avatar_url, createdAt: iso(user.created_at), updatedAt: iso(user.updated_at), lastLogin: iso(user.last_login)
  };
}

async function listColumn(table, idColumn, valueColumn, id) {
  const rows = await query(`SELECT ${valueColumn} AS value FROM ${table} WHERE ${idColumn} = $1`, [id]);
  return rows.map((row) => row.value);
}

function vocabFilter(queryParams) {
  const params = [];
  let where = 'WHERE 1=1';
  if (queryParams.hskLevel) {
    params.push(Number(queryParams.hskLevel));
    where += ` AND hsk_level = $${params.length}`;
  }
  if (blankToNull(queryParams.search)) {
    params.push('%' + queryParams.search.trim() + '%');
    where += ` AND (hanzi ILIKE $${params.length} OR pinyin ILIKE $${params.length} OR urdu_translation ILIKE $${params.length})`;
  }
  return { where, params };
}

function storedLessonType(value) {
  const type = String(value || '').toUpperCase();
  if (type === 'CHECKPOINT') return 'CHECKPOINT';
  if (type === 'REVIEW') return 'REVIEW';
  return 'NORMAL';
}

async function mustCourse(id) {
  const row = await queryOne('SELECT * FROM courses WHERE id = $1', [id]);
  if (!row) throw notFound('Course not found: ' + id);
  return row;
}
async function mustUnit(id) {
  const row = await queryOne('SELECT * FROM units WHERE id = $1', [id]);
  if (!row) throw notFound('Unit not found: ' + id);
  return row;
}
async function mustLesson(id) {
  const row = await queryOne('SELECT * FROM lessons WHERE id = $1', [id]);
  if (!row) throw notFound('Lesson not found: ' + id);
  return row;
}
async function mustExercise(id) {
  const row = await queryOne('SELECT * FROM exercises WHERE id = $1', [id]);
  if (!row) throw notFound('Exercise not found: ' + id);
  return row;
}
async function mustVocab(id) {
  const row = await queryOne('SELECT * FROM vocabulary WHERE id = $1', [id]);
  if (!row) throw notFound('Vocabulary not found: ' + id);
  return row;
}
async function mustUser(id) {
  const row = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
  if (!row) throw notFound('User not found: ' + id);
  return row;
}

module.exports = router;
