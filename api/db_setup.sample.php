<?php
// Одноразовый скрипт создания таблиц в базе данных.
// Скопируйте в db_setup.php, замените CHANGE_ME_SETUP_SECRET на свой случайный секрет,
// один раз откройте в браузере https://ваш-домен/api/db_setup.php?secret=ваш_секрет,
// затем удалите этот файл с сервера — он больше не нужен.

declare(strict_types=1);
require __DIR__ . '/helpers.php';

$secret = $_GET['secret'] ?? '';
if ($secret !== 'CHANGE_ME_SETUP_SECRET') {
    http_response_code(403);
    echo 'forbidden';
    exit;
}

$pdo = db();

$pdo->exec("CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'driver',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$pdo->exec("CREATE TABLE IF NOT EXISTS shifts (
    id VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    mode VARCHAR(20) NOT NULL,
    started_at BIGINT NOT NULL,
    ended_at BIGINT NULL,
    state VARCHAR(20) NOT NULL,
    segment_started_at BIGINT NOT NULL,
    mode_stats TEXT NOT NULL,
    break_seconds DOUBLE NOT NULL DEFAULT 0,
    distance_km DOUBLE NOT NULL DEFAULT 0,
    current_order TEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX(user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$pdo->exec("CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    shift_id VARCHAR(64) NOT NULL,
    user_id INT NOT NULL,
    started_at BIGINT NOT NULL,
    ended_at BIGINT NOT NULL,
    duration_sec DOUBLE NOT NULL,
    distance_km DOUBLE NOT NULL,
    mode VARCHAR(20) NOT NULL,
    payment DOUBLE NOT NULL,
    INDEX(shift_id),
    INDEX(user_id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$pdo->exec("CREATE TABLE IF NOT EXISTS expenses (
    id VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(20) NOT NULL,
    date BIGINT NOT NULL,
    amount DOUBLE NOT NULL,
    quantity DOUBLE NULL,
    comment VARCHAR(500) NULL,
    INDEX(user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$pdo->exec("CREATE TABLE IF NOT EXISTS user_settings (
    user_id INT PRIMARY KEY,
    commissions TEXT NULL,
    sheets_url VARCHAR(500) NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

echo 'OK: таблицы созданы';
