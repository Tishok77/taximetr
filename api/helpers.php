<?php
declare(strict_types=1);

session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 30, // 30 дней
    'path' => '/',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

header('Content-Type: application/json; charset=utf-8');

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $config = require __DIR__ . '/config.php';
        $dsn = "mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4";
        $pdo = new PDO($dsn, $config['db_user'], $config['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

function jsonInput(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function respond($data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function respondError(string $message, int $status = 400): void {
    respond(['ok' => false, 'error' => $message], $status);
}

function currentUserId(): ?int {
    return $_SESSION['user_id'] ?? null;
}

function requireAuth(): int {
    $id = currentUserId();
    if ($id === null) {
        respondError('Не авторизован', 401);
    }
    return $id;
}

function requireAdmin(): int {
    $id = requireAuth();
    $stmt = db()->prepare('SELECT role FROM users WHERE id = ?');
    $stmt->execute([$id]);
    $role = $stmt->fetchColumn();
    if ($role !== 'admin') {
        respondError('Доступ только для администратора', 403);
    }
    return $id;
}
