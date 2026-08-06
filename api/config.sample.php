<?php
// Скопируйте этот файл в config.php и укажите реальные данные подключения к MySQL.
// config.php НЕ должен попадать в git (см. .gitignore) — он содержит пароль от базы
// и загружается на сервер напрямую по FTP, а не через репозиторий.

return [
    'db_host' => 'localhost',
    'db_name' => 'db_name_here',
    'db_user' => 'db_user_here',
    'db_pass' => 'db_password_here',
];
