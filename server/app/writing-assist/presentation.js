const messages = {
  limit: ["Rewrite supports up to 2,000 characters.", "改寫最多支援 2,000 字元"],
  apply: ["Apply edited result", "套用修改結果"],
  retryRewrite: ["Retry rewrite", "重試改寫"],
  retryAudio: ["Retry transcription", "重試轉錄"],
  again: ["Record again", "重新錄音"],
  stale: ["The field changed. Copy any recovered text you want before discarding.", "這一欄的內容已變更。你可以先複製待處理文字，再捨棄。"],
  failed: ["Processing did not finish. Try again.", "處理未完成，請再試一次。"],
  pending: ["Finish or discard the recording in the other field first.", "請先完成或捨棄另一欄的錄音。"],
  cancelled: ["Cancelled.", "已取消。"],
  preparing: ["Preparing assistance…", "正在準備寫作工具…"],
  stopped: ["Processing stopped. Review the field before trying again.", "處理已停止，請檢查欄位後再試。"],
  waiting: ["Waiting for sign-in…", "等待登入…"],
  blocked: ["Allow sign-in popups and try again.", "請允許此網站開啟登入視窗，然後再試。"],
  loginFailed: ["Sign-in did not finish. Try again.", "登入未完成，請再試一次。"],
  offline: ["Could not start assistance. Check your connection and try again.", "未能啟動寫作工具，請檢查連線後再試。"],
  tools: ["Writing tools", "寫作工具"],
  rewritten: ["Rewritten", "已改寫"],
  restored: ["Restored", "已復原"],
  added: ["Voice text added", "已加入語音文字"],
  voice: ["Add by voice", "用語音加入"],
  rewrite: ["Rewrite", "改寫"],
  undo: ["Undo", "復原"],
  stop: ["Stop recording", "停止錄音"],
  cancel: ["Cancel", "取消"],
  recovery: ["Recovered text", "待處理文字"],
  login: ["Sign in", "登入"],
  retry: ["Retry", "再試一次"],
  discard: ["Discard", "捨棄"],
};
export const label = key => messages[key][/^zh/i.test(document.documentElement.lang) ? 1 : 0];

export function controls() {
  return `<button type="button" class="field-tools" aria-haspopup="menu" aria-expanded="false">•••</button>
<div class="field-actions">
<button type="button" data-action="voice">${label('voice')}</button>
<button type="button" data-action="rewrite">${label('rewrite')}</button>
<button type="button" data-action="undo">${label('undo')}</button>
</div>
<div class="field-progress">
<button type="button" data-action="stop" hidden>${label('stop')}</button>
<button type="button" data-action="cancel" hidden>${label('cancel')}</button>
</div>
<p class="assist-message" role="status"></p>
<div class="recovery" hidden>
<label>${label('recovery')}<textarea rows="2"></textarea></label>
<button type="button" data-action="login">${label('login')}</button>
<button type="button" data-action="retry">${label('retry')}</button>
<button type="button" data-action="discard">${label('discard')}</button>
</div>`;
}
