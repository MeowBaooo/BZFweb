/**
 * 丈量預約單 - 選材網站
 * 客戶瀏覽衛浴商品 -> 選材(可複選) -> 填寫聯絡資料 -> 一次送出
 * 寫入 BizForm「丈量預約單範本」表單（form.id=16）
 *
 * 注意：這張表單屬於不同的站台（depotId=d6dec2f63f1c47ec8e10af11e808a559），
 * 跟花藝/壽衣不是同一組，請確認您的 x-api-key 是否對這個站台有效，
 * 若無效需要另外申請這個站台專用的 API Key。
 */

const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const BIZFORM_BASE = 'https://bizform.vitalyun.com/backend/api';
const API_KEY = process.env.BIZFORM_API_KEY;
const FORM_ID = 16;

// 同步進 CRM 用（CRM 匯入 API 不支援 x-api-key，必須用個人 JWT）
// 這兩個值跟 webhook 服務（bizform-measurement-crm-sync）的環境變數一樣，直接複製過來即可
const CRM_JWT = process.env.BIZFORM_JWT;
const DEPOT_ID = process.env.BIZFORM_DEPOT_ID || 'd6dec2f63f1c47ec8e10af11e808a559';

/** 從建立文件的回應中找出新文件的 id（回應可能是數字或物件，都處理） */
function extractNewDocId(data) {
  if (typeof data === 'number') return data;
  if (typeof data === 'string' && /^\d+$/.test(data.trim())) return Number(data.trim());
  if (data && typeof data === 'object') {
    return data.id ?? data.Id ?? data.documentId ?? data.DocumentId ?? data.data?.id ?? null;
  }
  return null;
}

/** 呼叫 BizForm 的「同步到 CRM」 */
async function syncToCrm(documentId) {
  if (!CRM_JWT) throw new Error('尚未設定環境變數 BIZFORM_JWT，無法同步到 CRM');
  const res = await fetch(`${BIZFORM_BASE}/Documents/${documentId}/crmItems?version=0`, {
    method: 'POST',
    headers: {
      Authorization: CRM_JWT.startsWith('Bearer') ? CRM_JWT : `Bearer ${CRM_JWT}`,
      depotId: DEPOT_ID,
      accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 401) hint = '（JWT 可能已過期，請重新取得並更新 BIZFORM_JWT）';
    if (res.status === 400) hint = '（常見原因：表單 CRM 欄位對應不完整，或 CRM 欄位被改名/刪除）';
    if (res.status === 403) hint = '（帳號沒有此站台或 CRM 權限，或 depotId 錯誤）';
    throw new Error(`CRM 同步失敗：HTTP ${res.status} ${hint} 回應：${text}`);
  }
  return text;
}

// 各欄位真正的 id（field_N，來自表單 GET 回傳的 attributes）
const FIELD_IDS = {
  address: 'field_5',    // 丈量地址
  custName: 'field_7',   // 客戶姓名
  phone: 'field_8',      // 聯絡電話
  space: 'field_22',     // 裝修空間
  date: 'field_28',      // 希望丈量日期
  need: 'field_30',      // 裝修需求
  timeslot: 'field_33',  // 希望丈量時段
  material: 'field_34',  // 選材編號
  note: 'field_35',      // 備註
  email: 'field_36',     // 電子郵件
};

app.post('/api/submit', async (req, res) => {
  try {
    const { name, email, address, date, timeslot, space, need, note, materialCodes } = req.body;
    // 電話統一存成純數字（0912-345-678 → 0912345678），
    // 這樣 CRM 比對同一位客戶、LINE 用電話查進度/保固時才對得上
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (!name || !phone || !email || !address) {
      return res.status(400).json({ error: '請填寫所有必填欄位' });
    }

    const now = new Date().toISOString();

    const attributes = [
      { id: FIELD_IDS.address, value: [address] },
      { id: FIELD_IDS.custName, value: [name] },
      { id: FIELD_IDS.phone, value: [phone] },
      { id: FIELD_IDS.email, value: [email] },
      { id: FIELD_IDS.material, value: [materialCodes || ''] },
      { id: FIELD_IDS.date, value: [date || ''] },
      { id: FIELD_IDS.timeslot, value: [timeslot || ''] },
      { id: FIELD_IDS.space, value: [space || ''] },
      { id: FIELD_IDS.need, value: [need || ''] },
      { id: FIELD_IDS.note, value: [note || ''] },
    ];

    const body = {
      id: 0,
      form: { id: FORM_ID },
      title: phone,
      summary: address,
      attributes,
      attachments: [],
      categories: [],
      tags: [],
      creationDateTime: now,
      versionCreationDateTime: now,
      permissions: [],
      notificationSetting: { onDocumentCreated: [], onWorkflowCompleted: [] },
      owner: null,
      versionCreator: null,
      versionNumber: 1,
      subDocuments: [],
      state: 0,
      executedDateTime: now,
      lastAuditor: null,
    };

    const bizRes = await fetch(`${BIZFORM_BASE}/Documents`, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!bizRes.ok) {
      const text = await bizRes.text();
      console.error('BizForm create error:', bizRes.status, text);
      return res.status(502).json({ error: '寫入表單失敗，請稍後再試或聯絡工作人員' });
    }

    // 寫入 BizForm 成功 → 立刻同步到 CRM
    // （網站用 API 建立的文件，不一定會觸發 BizForm 的 webhook，所以這裡自己同步）
    const createdText = await bizRes.text();
    let createdData = createdText;
    try {
      createdData = JSON.parse(createdText);
    } catch {}
    const newDocId = extractNewDocId(createdData);

    if (!newDocId) {
      console.error('找不到新文件 id，無法同步 CRM。BizForm 回應：', createdText.slice(0, 1000));
    } else {
      try {
        await syncToCrm(newDocId);
        console.log(`CRM 同步成功：documentId=${newDocId}`);
      } catch (crmErr) {
        // CRM 失敗不影響客戶端顯示成功（資料已經在 BizForm 裡），只記錄在 Logs
        console.error(`documentId=${newDocId}`, crmErr.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
