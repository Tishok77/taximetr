<?php
declare(strict_types=1);
require __DIR__ . '/helpers.php';

$action = $_GET['action'] ?? ($_POST['action'] ?? '');

switch ($action) {
    case 'list_users': {
        requireAdmin();
        $pdo = db();

        $users = $pdo->query('SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC')->fetchAll();

        $shiftStats = $pdo->query(
            'SELECT user_id, COUNT(*) AS shifts_count, COALESCE(SUM(distance_km),0) AS distance_km, MAX(started_at) AS last_shift_started_at
             FROM shifts WHERE ended_at IS NOT NULL GROUP BY user_id'
        )->fetchAll(PDO::FETCH_ASSOC | PDO::FETCH_UNIQUE);

        $orderStats = $pdo->query(
            'SELECT user_id, COUNT(*) AS orders_count, COALESCE(SUM(payment),0) AS gross_payment
             FROM orders GROUP BY user_id'
        )->fetchAll(PDO::FETCH_ASSOC | PDO::FETCH_UNIQUE);

        $result = array_map(function ($u) use ($shiftStats, $orderStats) {
            $uid = (int)$u['id'];
            $s = $shiftStats[$uid] ?? ['shifts_count' => 0, 'distance_km' => 0, 'last_shift_started_at' => null];
            $o = $orderStats[$uid] ?? ['orders_count' => 0, 'gross_payment' => 0];
            return [
                'id' => $uid,
                'email' => $u['email'],
                'name' => $u['name'],
                'role' => $u['role'],
                'createdAt' => $u['created_at'],
                'shiftsCount' => (int)$s['shifts_count'],
                'distanceKm' => (float)$s['distance_km'],
                'lastShiftStartedAt' => $s['last_shift_started_at'] !== null ? (int)$s['last_shift_started_at'] : null,
                'ordersCount' => (int)$o['orders_count'],
                'grossPayment' => (float)$o['gross_payment'],
            ];
        }, $users);

        respond(['ok' => true, 'users' => $result]);
        break;
    }

    default:
        respondError('Неизвестное действие', 404);
}
