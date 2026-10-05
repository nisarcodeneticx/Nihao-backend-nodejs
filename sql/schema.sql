CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(100),
    role VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    avatar_url TEXT,
    google_id VARCHAR(64) UNIQUE,
    auth_provider VARCHAR(20) NOT NULL DEFAULT 'PASSWORD',
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    hsk_level VARCHAR(20) NOT NULL,
    description TEXT,
    difficulty VARCHAR(20),
    cover_image_url TEXT,
    status VARCHAR(20) NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    unit_number INT NOT NULL,
    urdu_title VARCHAR(100) NOT NULL,
    hanzi_title VARCHAR(100) NOT NULL,
    grammar_point TEXT,
    hsk_level VARCHAR(20),
    estimated_time INT,
    difficulty VARCHAR(20),
    status VARCHAR(20) NOT NULL,
    version INT,
    published_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    lesson_number INT NOT NULL,
    lesson_type VARCHAR(20) NOT NULL,
    urdu_title VARCHAR(100) NOT NULL,
    instruction_text TEXT,
    difficulty VARCHAR(20),
    crowns INT,
    status VARCHAR(20) NOT NULL,
    exercises_count INT,
    words_count INT,
    created_by TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    exercise_type VARCHAR(50) NOT NULL,
    exercise_data JSONB NOT NULL,
    exercise_order INT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vocabulary (
    id TEXT PRIMARY KEY,
    hanzi VARCHAR(50) NOT NULL,
    pinyin VARCHAR(100) NOT NULL,
    tone INT,
    urdu_translation TEXT NOT NULL,
    roman_urdu VARCHAR(100),
    literal_gloss TEXT,
    part_of_speech VARCHAR(50),
    hsk_level INT,
    frequency INT,
    stroke_count INT,
    radical VARCHAR(50),
    audio_male_url TEXT,
    audio_female_url TEXT,
    illustration_url TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS example_sentences (
    id TEXT PRIMARY KEY,
    vocabulary_id TEXT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    hanzi TEXT NOT NULL,
    pinyin TEXT NOT NULL,
    urdu TEXT NOT NULL,
    created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS unit_topics (
    unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    topic TEXT
);

CREATE TABLE IF NOT EXISTS unit_objectives (
    unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    objective TEXT
);

CREATE TABLE IF NOT EXISTS vocabulary_topics (
    vocabulary_id TEXT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    topic TEXT
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_xp INT NOT NULL DEFAULT 0,
    level INT NOT NULL DEFAULT 1,
    streak_days INT NOT NULL DEFAULT 0,
    last_activity_date DATE,
    total_crowns INT NOT NULL DEFAULT 0,
    words_learned INT NOT NULL DEFAULT 0,
    completed_lessons INT NOT NULL DEFAULT 0,
    current_course_id TEXT,
    current_unit_number INT,
    current_lesson_number INT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_course_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    is_unlocked BOOLEAN NOT NULL DEFAULT TRUE,
    progress_percent REAL NOT NULL DEFAULT 0,
    completed_units INT NOT NULL DEFAULT 0,
    completed_words INT NOT NULL DEFAULT 0,
    total_crowns INT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    UNIQUE (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS user_unit_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    state VARCHAR(20) NOT NULL DEFAULT 'locked',
    is_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    completed_lessons INT NOT NULL DEFAULT 0,
    completed_items INT NOT NULL DEFAULT 0,
    crowns INT NOT NULL DEFAULT 0,
    checkpoint_completed BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ,
    UNIQUE (user_id, unit_id)
);

CREATE TABLE IF NOT EXISTS user_lesson_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    state VARCHAR(20) NOT NULL DEFAULT 'locked',
    is_complete BOOLEAN NOT NULL DEFAULT FALSE,
    earned_crowns INT NOT NULL DEFAULT 0,
    completed_items INT NOT NULL DEFAULT 0,
    xp_earned INT NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    UNIQUE (user_id, lesson_id)
);
