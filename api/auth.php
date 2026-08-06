<?php
declare(strict_types=1);
require __DIR__ . '/helpers.php';

$action = $_GET['action'] ?? ($_POST['action'] ?? '');
$input = jsonInput();

switch ($action) {
    case 'register': {
        $email = trim(strtolower((string)($input['email'] ?? '')));
        $password = (string)($input['password'] ?? '');
        $name = trim((string)($input['name'] ?? ''));

        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            respondError('Некорректный email');
        }
        if (strlen($password) < 6) {
            respondError('Пароль должен быть не короче 6 символов');
        }
        if ($name === '') {
            respondError('Укажите имя');
        }

        $pdo = db();
        $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            respondError('Пользователь с таким email уже зарегистрирован');
        }

        $isFirst = ((int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn()) === 0;
        $role = $isFirst ? 'admin' : 'driver';
        $hash = password_hash($password, PASSWORD_DEFAULT);

        $stmt = $pdo->prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)');
        $stmt->execute([$email, $hash, $name, $role]);
        $userId = (int)$pdo->lastInsertId();

        session_regenerate_id(true);
        $_SESSION['user_id'] = $userId;

        respond(['ok' => true, 'user' => ['id' => $userId, 'email' => $email, 'name' => $name, 'role' => $role]]);
        break;
    }

    case 'login': {
        $email = trim(strtolower((string)($input['email'] ?? '')));
        $password = (string)($input['password'] ?? '');

        $stmt = db()->prepare('SELECT id, password_hash, name, role FROM users WHERE email = ?');
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password_hash'])) {
            respondError('Неверный email или пароль', 401);
        }

        session_regenerate_id(true);
        $_SESSION['user_id'] = (int)$user['id'];

        respond(['ok' => true, 'user' => [
            'id' => (int)$user['id'], 'email' => $email, 'name' => $user['name'], 'role' => $user['role'],
        ]]);
        break;
    }

    case 'logout': {
        $_SESSION = [];
        session_destroy();
        respond(['ok' => true]);
        break;
    }

    case 'me': {
        $id = currentUserId();
        if ($id === null) {
            respond(['ok' => true, 'user' => null]);
        }
        $stmt = db()->prepare('SELECT id, email, name, role FROM users WHERE id = ?');
        $stmt->execute([$id]);
        $user = $stmt->fetch();
        if (!$user) {
            $_SESSION = [];
            respond(['ok' => true, 'user' => null]);
        }
        $user['id'] = (int)$user['id'];
        respond(['ok' => true, 'user' => $user]);
        break;
    }

    default:
        respondError('Неизвестное действие', 404);
}
