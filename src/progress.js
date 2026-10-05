const { query, queryOne } = require('./db');
const { badRequest, notFound, isLive, num, text } = require('./util');

async function getOrCreateProfile(userId, client) {
  const existing = await queryOne('SELECT * FROM user_profiles WHERE user_id = $1', [userId], client);
  if (existing) return existing;
  await query(
    `INSERT INTO user_profiles (user_id, total_xp, level, streak_days, total_crowns, words_learned, completed_lessons, created_at, updated_at)
     VALUES ($1,0,1,0,0,0,0,NOW(),NOW())`,
    [userId],
    client
  );
  return queryOne('SELECT * FROM user_profiles WHERE user_id = $1', [userId], client);
}

async function liveUnits(courseId, client) {
  const rows = await query(
    'SELECT * FROM units WHERE course_id = $1 ORDER BY unit_number ASC',
    [courseId],
    client
  );
  return rows.filter((row) => isLive(row.status));
}

async function liveLessons(unitId, client) {
  const rows = await query(
    'SELECT * FROM lessons WHERE unit_id = $1 ORDER BY lesson_number ASC',
    [unitId],
    client
  );
  return rows.filter((row) => isLive(row.status));
}

async function countWords(courseId, client) {
  const units = await liveUnits(courseId, client);
  let total = 0;
  for (const unit of units) {
    const lessons = await liveLessons(unit.id, client);
    total += lessons.reduce((sum, lesson) => sum + num(lesson.words_count), 0);
  }
  return total;
}

async function ensureCourseProgress(userId, courseId, client) {
  const course = await queryOne('SELECT * FROM courses WHERE id = $1', [courseId], client);
  if (!course || !isLive(course.status)) throw notFound('Course not found: ' + courseId);
  const existing = await queryOne(
    'SELECT * FROM user_course_progress WHERE user_id = $1 AND course_id = $2',
    [userId, courseId],
    client
  );
  if (existing) return;
  const units = await liveUnits(courseId, client);
  await query(
    `INSERT INTO user_course_progress
      (id, user_id, course_id, is_unlocked, progress_percent, completed_units, completed_words, total_crowns, started_at, updated_at)
     VALUES ($1,$2,$3,TRUE,0,0,0,0,NOW(),NOW())`,
    [crypto.randomUUID(), userId, courseId],
    client
  );
  const profile = await getOrCreateProfile(userId, client);
  if (!profile.current_course_id && units.length) {
    await query(
      `UPDATE user_profiles SET current_course_id = $2, current_unit_number = $3, current_lesson_number = 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, courseId, units[0].unit_number],
      client
    );
  }
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex];
    const lessons = await liveLessons(unit.id, client);
    const unitUnlocked = unitIndex === 0;
    await query(
      `INSERT INTO user_unit_progress
        (id, user_id, unit_id, state, is_unlocked, completed_lessons, completed_items, crowns, checkpoint_completed, updated_at)
       VALUES ($1,$2,$3,$4,$5,0,0,0,FALSE,NOW())
       ON CONFLICT (user_id, unit_id) DO NOTHING`,
      [crypto.randomUUID(), userId, unit.id, unitUnlocked ? 'active' : 'locked', unitUnlocked],
      client
    );
    for (let lessonIndex = 0; lessonIndex < lessons.length; lessonIndex += 1) {
      const available = unitUnlocked && lessonIndex === 0;
      await query(
        `INSERT INTO user_lesson_progress
          (id, user_id, lesson_id, state, is_complete, earned_crowns, completed_items, xp_earned, updated_at)
         VALUES ($1,$2,$3,$4,FALSE,0,0,0,NOW())
         ON CONFLICT (user_id, lesson_id) DO NOTHING`,
        [crypto.randomUUID(), userId, lessons[lessonIndex].id, available ? 'available' : 'locked'],
        client
      );
    }
  }
}

async function progressDto(userId) {
  const profile = await getOrCreateProfile(userId);
  const total = await queryOne('SELECT COUNT(*)::int AS count FROM lessons');
  return {
    currentUnit: num(profile.current_unit_number, 1),
    currentLesson: num(profile.current_lesson_number, 1),
    totalXp: num(profile.total_xp),
    streak: num(profile.streak_days),
    crowns: num(profile.total_crowns),
    wordsLearned: num(profile.words_learned),
    completedLessons: num(profile.completed_lessons),
    totalLessons: num(total.count)
  };
}

async function courseProgressDto(userId, courseId) {
  await ensureCourseProgress(userId, courseId);
  const profile = await getOrCreateProfile(userId);
  const courseProgress = await queryOne(
    'SELECT * FROM user_course_progress WHERE user_id = $1 AND course_id = $2',
    [userId, courseId]
  );
  const units = await liveUnits(courseId);
  return {
    xp: num(profile.total_xp),
    level: num(profile.level, 1),
    streak: num(profile.streak_days),
    completedUnits: num(courseProgress.completed_units),
    totalUnits: units.length,
    completedWords: num(courseProgress.completed_words),
    totalWords: await countWords(courseId),
    totalCrowns: num(courseProgress.total_crowns)
  };
}

async function coursePercent(userId, courseId) {
  await ensureCourseProgress(userId, courseId);
  const row = await queryOne(
    'SELECT progress_percent FROM user_course_progress WHERE user_id = $1 AND course_id = $2',
    [userId, courseId]
  );
  return row ? Number(row.progress_percent) : 0;
}

async function league(userId) {
  await getOrCreateProfile(userId);
  const profiles = await query(
    `SELECT p.*, u.full_name, u.username
     FROM user_profiles p JOIN users u ON u.id = p.user_id
     ORDER BY p.total_xp DESC LIMIT 100`
  );
  const entries = [];
  let yourRank = 0;
  profiles.forEach((profile, index) => {
    const rank = index + 1;
    const current = profile.user_id === userId;
    if (current) yourRank = rank;
    entries.push({
      userId: profile.user_id,
      name: text(profile.full_name, profile.username || 'طالب علم'),
      xp: num(profile.total_xp),
      rank,
      currentUser: current
    });
  });
  if (yourRank === 0) {
    const mine = await getOrCreateProfile(userId);
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    yourRank = entries.length + 1;
    entries.push({
      userId,
      name: user ? text(user.full_name, user.username) : 'طالب علم',
      xp: num(mine.total_xp),
      rank: yourRank,
      currentUser: true
    });
  }
  return { name: 'gold', yourRank, entries };
}

async function completeLesson(userId, lessonId, body) {
  const lesson = await queryOne(
    `SELECT l.*, u.id AS unit_id, u.unit_number, u.course_id, u.status AS unit_status
     FROM lessons l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`,
    [lessonId]
  );
  if (!lesson || !isLive(lesson.status)) throw notFound('Lesson not found: ' + lessonId);
  await ensureCourseProgress(userId, lesson.course_id);
  const lessonProgress = await queryOne(
    'SELECT * FROM user_lesson_progress WHERE user_id = $1 AND lesson_id = $2',
    [userId, lessonId]
  );
  if (!lessonProgress) throw badRequest('Lesson progress not initialized');
  if (lessonProgress.is_complete) throw badRequest('Lesson already completed');
  if (String(lessonProgress.state).toLowerCase() !== 'available') throw badRequest('Lesson is not available yet');

  const earnedCrowns = clamp(body.earnedCrowns, 0, num(lesson.crowns, 3));
  const xpEarned = Math.max(0, num(body.xpEarned, 10));
  const completedItems = num(lesson.words_count);
  await query(
    `UPDATE user_lesson_progress
     SET is_complete = TRUE, state = 'complete', earned_crowns = $3, xp_earned = $4,
         completed_items = $5, completed_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND lesson_id = $2`,
    [userId, lessonId, earnedCrowns, xpEarned, completedItems]
  );

  const unitProgress = await queryOne(
    'SELECT * FROM user_unit_progress WHERE user_id = $1 AND unit_id = $2',
    [userId, lesson.unit_id]
  );
  const unitLessons = await liveLessons(lesson.unit_id);
  const progressRows = await query(
    `SELECT * FROM user_lesson_progress WHERE user_id = $1 AND lesson_id = ANY($2::text[])`,
    [userId, unitLessons.map((item) => item.id)]
  );
  const progressMap = new Map(progressRows.map((row) => [row.lesson_id, row]));
  progressMap.set(lessonId, { ...lessonProgress, is_complete: true });
  const unitComplete = unitLessons
    .filter((item) => String(item.lesson_type).toUpperCase() !== 'CHECKPOINT')
    .every((item) => progressMap.get(item.id)?.is_complete);
  let unitState = unitProgress.state;
  if (unitComplete) unitState = 'complete';
  else if (String(unitState).toLowerCase() === 'locked') unitState = 'active';
  await query(
    `UPDATE user_unit_progress
     SET completed_lessons = completed_lessons + 1,
         completed_items = completed_items + $3,
         crowns = crowns + $4,
         checkpoint_completed = checkpoint_completed OR $5,
         state = $6,
         updated_at = NOW()
     WHERE user_id = $1 AND unit_id = $2`,
    [userId, lesson.unit_id, completedItems, earnedCrowns, String(lesson.lesson_type).toUpperCase() === 'CHECKPOINT', unitState]
  );
  await unlockNextLesson(userId, unitLessons, lessonId);
  if (unitComplete) await unlockNextUnit(userId, lesson.course_id, lesson.unit_number);

  const profile = await getOrCreateProfile(userId);
  const streak = nextStreak(profile);
  const totalXp = num(profile.total_xp) + xpEarned;
  await query(
    `UPDATE user_profiles
     SET total_xp = $2, level = $3, total_crowns = total_crowns + $4, words_learned = words_learned + $5,
         completed_lessons = completed_lessons + 1, current_course_id = $6, current_unit_number = $7,
         current_lesson_number = $8, streak_days = $9, last_activity_date = CURRENT_DATE, updated_at = NOW()
     WHERE user_id = $1`,
    [userId, totalXp, Math.max(1, Math.floor(totalXp / 100) + 1), earnedCrowns, completedItems, lesson.course_id, lesson.unit_number, lesson.lesson_number, streak.days]
  );
  const courseProgress = await queryOne(
    'SELECT * FROM user_course_progress WHERE user_id = $1 AND course_id = $2',
    [userId, lesson.course_id]
  );
  const completedUnits = num(courseProgress.completed_units) + (unitComplete ? 1 : 0);
  const totalUnits = (await liveUnits(lesson.course_id)).length;
  const percent = totalUnits === 0 ? 0 : (completedUnits * 100) / totalUnits;
  await query(
    `UPDATE user_course_progress
     SET completed_words = completed_words + $3, total_crowns = total_crowns + $4,
         completed_units = $5, progress_percent = $6, updated_at = NOW()
     WHERE user_id = $1 AND course_id = $2`,
    [userId, lesson.course_id, completedItems, earnedCrowns, completedUnits, percent]
  );
  return {
    lessonId,
    xpEarned,
    earnedCrowns,
    totalXp,
    streak: streak.days,
    level: Math.max(1, Math.floor(totalXp / 100) + 1),
    courseProgress: await courseProgressDto(userId, lesson.course_id)
  };
}

async function unlockNextLesson(userId, lessons, lessonId) {
  const index = lessons.findIndex((lesson) => lesson.id === lessonId);
  if (index < 0 || index + 1 >= lessons.length) return;
  const next = lessons[index + 1];
  await query(
    `UPDATE user_lesson_progress SET state = 'available', updated_at = NOW()
     WHERE user_id = $1 AND lesson_id = $2 AND lower(state) = 'locked'`,
    [userId, next.id]
  );
}

async function unlockNextUnit(userId, courseId, unitNumber) {
  const units = await liveUnits(courseId);
  const index = units.findIndex((unit) => unit.unit_number === unitNumber);
  if (index < 0 || index + 1 >= units.length) return;
  const next = units[index + 1];
  await query(
    `UPDATE user_unit_progress SET is_unlocked = TRUE, state = 'active', updated_at = NOW()
     WHERE user_id = $1 AND unit_id = $2`,
    [userId, next.id]
  );
  const lessons = await liveLessons(next.id);
  if (lessons.length) {
    await query(
      `UPDATE user_lesson_progress SET state = 'available', updated_at = NOW()
       WHERE user_id = $1 AND lesson_id = $2 AND lower(state) = 'locked'`,
      [userId, lessons[0].id]
    );
  }
  await query(
    `UPDATE user_profiles SET current_unit_number = $2, current_lesson_number = $3, updated_at = NOW() WHERE user_id = $1`,
    [userId, next.unit_number, lessons.length ? lessons[0].lesson_number : 1]
  );
}

function nextStreak(profile) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last = profile.last_activity_date ? new Date(profile.last_activity_date) : null;
  if (last) last.setHours(0, 0, 0, 0);
  let days = num(profile.streak_days);
  if (!last) days = 1;
  else if (last.getTime() === today.getTime()) days = days;
  else if (today.getTime() - last.getTime() === 86400000) days += 1;
  else days = 1;
  return { days };
}

function clamp(value, min, max) {
  const actual = value == null || value === '' ? min : Number(value);
  return Math.max(min, Math.min(max, actual));
}

module.exports = {
  getOrCreateProfile, liveUnits, liveLessons, countWords, ensureCourseProgress,
  progressDto, courseProgressDto, coursePercent, league, completeLesson
};
