// Этот файл нужно вставить в Google Apps Script (script.google.com),
// открытый из вашей Google Таблицы через Extensions → Apps Script.
// Сам файл в приложении не используется — он не подключён к index.html.

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  for (var sheetName in data.sheets) {
    var rows = data.sheets[sheetName];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    sheet.clear();
    if (rows.length > 0) {
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput('Taximetr export endpoint работает. Используйте POST для выгрузки данных.');
}
