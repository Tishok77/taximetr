<?php
declare(strict_types=1);
require __DIR__ . '/helpers.php';

function shiftRowToClient(PDO $pdo, array $row): array {
    $stmt = $pdo->prepare('SELECT id, started_at, ended_at, duration_sec, distance_km, mode, payment FROM orders WHERE shift_id = ? ORDER BY started_at ASC');
    $stmt->execute([$row['id']]);
    $orders = array_map(function ($o) {
        return [
            'id' => $o['id'],
            'startedAt' => (int)$o['started_at'],
            'endedAt' => (int)$o['ended_at'],
            'durationSec' => (float)$o['duration_sec'],
            'distanceKm' => (float)$o['distance_km'],
            'mode' => $o['mode'],
            'payment' => (float)$o['payment'],
        ];
    }, $stmt->fetchAll());

    return [
        'id' => $row['id'],
        'mode' => $row['mode'],
        'startedAt' => (int)$row['started_at'],
        'endedAt' => $row['ended_at'] === null ? null : (int)$row['ended_at'],
        'state' => $row['state'],
        'segmentStartedAt' => (int)$row['segment_started_at'],
        'modeStats' => json_decode((string)$row['mode_stats'], true),
        'breakSeconds' => (float)$row['break_seconds'],
        'distanceKm' => (float)$row['distance_km'],
        'currentOrder' => $row['current_order'] ? json_decode((string)$row['current_order'], true) : null,
        'orders' => $orders,
    ];
}

$action = $_GET['action'] ?? ($_POST['action'] ?? '');
$input = jsonInput();

switch ($action) {
    case 'get_state': {
        $userId = requireAuth();
        $pdo = db();

        $stmt = $pdo->prepare('SELECT * FROM shifts WHERE user_id = ? AND ended_at IS NULL LIMIT 1');
        $stmt->execute([$userId]);
        $currentRow = $stmt->fetch();
        $current = $currentRow ? shiftRowToClient($pdo, $currentRow) : null;

        $stmt = $pdo->prepare('SELECT * FROM shifts WHERE user_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC');
        $stmt->execute([$userId]);
        $history = array_map(fn($row) => shiftRowToClient($pdo, $row), $stmt->fetchAll());

        $stmt = $pdo->prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC');
        $stmt->execute([$userId]);
        $expenses = array_map(function ($row) {
            return [
                'id' => $row['id'],
                'type' => $row['type'],
                'date' => (int)$row['date'],
                'amount' => (float)$row['amount'],
                'quantity' => $row['quantity'] === null ? null : (float)$row['quantity'],
                'comment' => $row['comment'],
            ];
        }, $stmt->fetchAll());

        $stmt = $pdo->prepare('SELECT commissions, sheets_url FROM user_settings WHERE user_id = ?');
        $stmt->execute([$userId]);
        $settingsRow = $stmt->fetch();
        $commissions = ($settingsRow && $settingsRow['commissions']) ? json_decode((string)$settingsRow['commissions'], true) : null;
        $sheetsUrl = $settingsRow['sheets_url'] ?? '';

        respond([
            'ok' => true,
            'current' => $current,
            'history' => $history,
            'expenses' => $expenses,
            'commissions' => $commissions,
            'sheetsUrl' => $sheetsUrl,
        ]);
        break;
    }

    case 'save_current_shift': {
        $userId = requireAuth();
        $s = $input['shift'] ?? null;
        if (!$s || empty($s['id'])) respondError('Нет данных смены');

        $pdo = db();
        $modeStats = json_encode($s['modeStats'] ?? new stdClass(), JSON_UNESCAPED_UNICODE);
        $currentOrder = (!empty($s['currentOrder'])) ? json_encode($s['currentOrder'], JSON_UNESCAPED_UNICODE) : null;

        $stmt = $pdo->prepare('SELECT id FROM shifts WHERE id = ? AND user_id = ?');
        $stmt->execute([$s['id'], $userId]);

        if ($stmt->fetch()) {
            $stmt = $pdo->prepare('UPDATE shifts SET mode=?, started_at=?, ended_at=?, state=?, segment_started_at=?, mode_stats=?, break_seconds=?, distance_km=?, current_order=? WHERE id=? AND user_id=?');
            $stmt->execute([
                $s['mode'], $s['startedAt'], $s['endedAt'] ?? null, $s['state'], $s['segmentStartedAt'],
                $modeStats, $s['breakSeconds'], $s['distanceKm'], $currentOrder, $s['id'], $userId,
            ]);
        } else {
            $stmt = $pdo->prepare('INSERT INTO shifts (id, user_id, mode, started_at, ended_at, state, segment_started_at, mode_stats, break_seconds, distance_km, current_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
            $stmt->execute([
                $s['id'], $userId, $s['mode'], $s['startedAt'], $s['endedAt'] ?? null, $s['state'], $s['segmentStartedAt'],
                $modeStats, $s['breakSeconds'], $s['distanceKm'], $currentOrder,
            ]);
        }

        respond(['ok' => true]);
        break;
    }

    case 'finish_shift': {
        $userId = requireAuth();
        $s = $input['shift'] ?? null;
        if (!$s || empty($s['id'])) respondError('Нет данных смены');

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $modeStats = json_encode($s['modeStats'] ?? new stdClass(), JSON_UNESCAPED_UNICODE);

            $stmt = $pdo->prepare('SELECT id FROM shifts WHERE id = ? AND user_id = ?');
            $stmt->execute([$s['id'], $userId]);

            if ($stmt->fetch()) {
                $stmt = $pdo->prepare('UPDATE shifts SET mode=?, started_at=?, ended_at=?, state=?, segment_started_at=?, mode_stats=?, break_seconds=?, distance_km=?, current_order=NULL WHERE id=? AND user_id=?');
                $stmt->execute([
                    $s['mode'], $s['startedAt'], $s['endedAt'], $s['state'], $s['segmentStartedAt'],
                    $modeStats, $s['breakSeconds'], $s['distanceKm'], $s['id'], $userId,
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shifts (id, user_id, mode, started_at, ended_at, state, segment_started_at, mode_stats, break_seconds, distance_km, current_order) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)');
                $stmt->execute([
                    $s['id'], $userId, $s['mode'], $s['startedAt'], $s['endedAt'], $s['state'], $s['segmentStartedAt'],
                    $modeStats, $s['breakSeconds'], $s['distanceKm'],
                ]);
            }

            $stmt = $pdo->prepare('DELETE FROM orders WHERE shift_id = ? AND user_id = ?');
            $stmt->execute([$s['id'], $userId]);

            $insertOrder = $pdo->prepare('INSERT INTO orders (id, shift_id, user_id, started_at, ended_at, duration_sec, distance_km, mode, payment) VALUES (?,?,?,?,?,?,?,?,?)');
            foreach (($s['orders'] ?? []) as $o) {
                $insertOrder->execute([
                    $o['id'], $s['id'], $userId, $o['startedAt'], $o['endedAt'],
                    $o['durationSec'], $o['distanceKm'], $o['mode'] ?? $s['mode'], $o['payment'],
                ]);
            }

            $pdo->commit();
        } catch (Exception $e) {
            $pdo->rollBack();
            respondError('Ошибка сохранения смены', 500);
        }

        respond(['ok' => true]);
        break;
    }

    case 'delete_shift': {
        $userId = requireAuth();
        $id = (string)($input['id'] ?? '');
        if ($id === '') respondError('Не указан id смены');
        $stmt = db()->prepare('DELETE FROM shifts WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);
        respond(['ok' => true]);
        break;
    }

    case 'add_expense': {
        $userId = requireAuth();
        $e = $input['expense'] ?? null;
        if (!$e || empty($e['id'])) respondError('Нет данных расхода');
        $stmt = db()->prepare('INSERT INTO expenses (id, user_id, type, date, amount, quantity, comment) VALUES (?,?,?,?,?,?,?)');
        $stmt->execute([
            $e['id'], $userId, $e['type'], $e['date'], $e['amount'],
            $e['quantity'] ?? null, $e['comment'] ?? '',
        ]);
        respond(['ok' => true]);
        break;
    }

    case 'delete_expense': {
        $userId = requireAuth();
        $id = (string)($input['id'] ?? '');
        if ($id === '') respondError('Не указан id расхода');
        $stmt = db()->prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);
        respond(['ok' => true]);
        break;
    }

    case 'save_settings': {
        $userId = requireAuth();
        $commissions = array_key_exists('commissions', $input) && $input['commissions'] !== null
            ? json_encode($input['commissions'], JSON_UNESCAPED_UNICODE) : null;
        $sheetsUrl = array_key_exists('sheetsUrl', $input) ? $input['sheetsUrl'] : null;

        $pdo = db();
        $stmt = $pdo->prepare('SELECT user_id FROM user_settings WHERE user_id = ?');
        $stmt->execute([$userId]);

        if ($stmt->fetch()) {
            $stmt = $pdo->prepare('UPDATE user_settings SET commissions = COALESCE(?, commissions), sheets_url = COALESCE(?, sheets_url) WHERE user_id = ?');
            $stmt->execute([$commissions, $sheetsUrl, $userId]);
        } else {
            $stmt = $pdo->prepare('INSERT INTO user_settings (user_id, commissions, sheets_url) VALUES (?, ?, ?)');
            $stmt->execute([$userId, $commissions, $sheetsUrl]);
        }

        respond(['ok' => true]);
        break;
    }

    default:
        respondError('Неизвестное действие', 404);
}
