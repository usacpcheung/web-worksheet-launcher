import { translate, getActiveLocale, onLocaleChange } from '../i18n.js';
import { buildDiscussionPrintHtml, buildDiscussionPrintModel } from './discussion-print.js';

// Owns page-session print preferences and the details/print workflow.
// The app keeps ownership of the active project, discussion and modal lifecycle.
export function createDiscussionPrintController({ getActiveProject, discussionSession, dialogs, showMessage }) {
  let discussionPrintDetails = { schoolName: '', schoolNameCustom: false, studentName: '' };

  function getDefaultDiscussionPrintSchoolName() {
    return translate('player.discussion.defaultSchoolName');
  }

  function formatDiscussionPrintDate(date = new Date()) {
    try {
      return new Intl.DateTimeFormat(getActiveLocale(), {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(date);
    } catch {
      return date.toLocaleDateString();
    }
  }

  function readDiscussionPrintDetailsDraft() {
    const storedSchoolName = String(discussionPrintDetails.schoolName || '').trim();
    const useCustomSchoolName = discussionPrintDetails.schoolNameCustom && storedSchoolName;
    return {
      schoolName: useCustomSchoolName ? storedSchoolName : getDefaultDiscussionPrintSchoolName(),
      schoolNameCustom: useCustomSchoolName,
      studentName: String(discussionPrintDetails.studentName || '').trim(),
    };
  }

  function promptDiscussionPrintDetails() {
    if (!dialogs.isAvailable()) {
      return Promise.resolve(readDiscussionPrintDetailsDraft());
    }
    const draft = readDiscussionPrintDetailsDraft();
    return new Promise((resolve) => {
      let resolved = false;
      let schoolInput = null;
      let studentInput = null;
      let defaultModeButton = null;
      let customModeButton = null;
      let schoolNameCustom = draft.schoolNameCustom;
      let unsubscribeLocaleChange = null;
      const settle = (value) => {
        if (resolved) return;
        resolved = true;
        if (unsubscribeLocaleChange) {
          unsubscribeLocaleChange();
          unsubscribeLocaleChange = null;
        }
        resolve(value);
      };
      const collectDetails = () => {
        const rawSchoolName = String(schoolInput?.value || '').trim();
        const nextSchoolName = schoolNameCustom
          ? rawSchoolName || getDefaultDiscussionPrintSchoolName()
          : getDefaultDiscussionPrintSchoolName();
        return {
          schoolName: nextSchoolName,
          schoolNameCustom: schoolNameCustom && Boolean(rawSchoolName),
          studentName: String(studentInput?.value || '').trim(),
        };
      };
      const syncSchoolNameMode = () => {
        if (schoolInput) {
          schoolInput.readOnly = !schoolNameCustom;
          schoolInput.classList.toggle('discussion-print-details-form__input--readonly', !schoolNameCustom);
          if (!schoolNameCustom) {
            schoolInput.value = getDefaultDiscussionPrintSchoolName();
          }
        }
        if (defaultModeButton) {
          defaultModeButton.setAttribute('aria-pressed', schoolNameCustom ? 'false' : 'true');
          defaultModeButton.classList.toggle('is-active', !schoolNameCustom);
        }
        if (customModeButton) {
          customModeButton.setAttribute('aria-pressed', schoolNameCustom ? 'true' : 'false');
          customModeButton.classList.toggle('is-active', schoolNameCustom);
        }
      };

      dialogs.open({
        title: translate('player.discussion.printDetailsTitle'),
        bodyRenderer: (body) => {
          const form = document.createElement('form');
          form.className = 'discussion-print-details-form';

          const schoolLabel = document.createElement('label');
          schoolLabel.className = 'discussion-print-details-form__label';
          schoolLabel.textContent = translate('player.discussion.printSchoolName');
          const schoolModeRow = document.createElement('div');
          schoolModeRow.className = 'discussion-print-details-form__mode-row';
          const schoolModeLabel = document.createElement('span');
          schoolModeLabel.className = 'discussion-print-details-form__mode-label';
          schoolModeLabel.textContent = translate('player.discussion.printSchoolNameMode');
          const schoolModeGroup = document.createElement('div');
          schoolModeGroup.className = 'discussion-print-details-form__mode';
          schoolModeGroup.setAttribute('role', 'group');
          schoolModeGroup.setAttribute('aria-label', translate('player.discussion.printSchoolNameMode'));
          defaultModeButton = document.createElement('button');
          defaultModeButton.type = 'button';
          defaultModeButton.className = 'discussion-print-details-form__mode-button';
          defaultModeButton.textContent = translate('player.discussion.printSchoolNameDefault');
          defaultModeButton.addEventListener('click', () => {
            schoolNameCustom = false;
            syncSchoolNameMode();
          });
          customModeButton = document.createElement('button');
          customModeButton.type = 'button';
          customModeButton.className = 'discussion-print-details-form__mode-button';
          customModeButton.textContent = translate('player.discussion.printSchoolNameCustom');
          customModeButton.addEventListener('click', () => {
            schoolNameCustom = true;
            syncSchoolNameMode();
            schoolInput?.focus();
          });
          schoolModeGroup.append(defaultModeButton, customModeButton);
          schoolModeRow.append(schoolModeLabel, schoolModeGroup);
          schoolInput = document.createElement('input');
          schoolInput.type = 'text';
          schoolInput.maxLength = 180;
          schoolInput.value = draft.schoolName;
          schoolInput.className = 'discussion-print-details-form__input';
          schoolInput.autocomplete = 'organization';
          schoolInput.addEventListener('input', () => { schoolNameCustom = true; syncSchoolNameMode(); });
          schoolLabel.appendChild(schoolInput);

          const studentLabel = document.createElement('label');
          studentLabel.className = 'discussion-print-details-form__label';
          studentLabel.textContent = translate('player.discussion.printStudentName');
          studentInput = document.createElement('input');
          studentInput.type = 'text';
          studentInput.maxLength = 120;
          studentInput.value = draft.studentName;
          studentInput.placeholder = translate('player.discussion.printStudentNamePlaceholder');
          studentInput.className = 'discussion-print-details-form__input';
          studentInput.autocomplete = 'name';
          studentLabel.appendChild(studentInput);

          form.addEventListener('submit', (event) => {
            event.preventDefault();
            const details = collectDetails();
            discussionPrintDetails = details;
            settle(details);
            dialogs.close('print');
          });
          form.append(schoolModeRow, schoolLabel, studentLabel);
          body.appendChild(form);
          syncSchoolNameMode();
          unsubscribeLocaleChange = onLocaleChange(() => {
            if (!schoolInput || schoolNameCustom) return;
            syncSchoolNameMode();
          });
        },
        actions: [
          {
            label: translate('player.discussion.printDetailsCancel'),
            className: 'confirm-actions__secondary',
            value: null,
            onClick: () => {
              settle(null);
              dialogs.close('cancel');
            },
          },
          {
            label: translate('player.discussion.printDetailsPrint'),
            className: 'confirm-actions__primary',
            onClick: () => {
              const details = collectDetails();
              discussionPrintDetails = details;
              settle(details);
              dialogs.close('print');
            },
          },
        ],
        onClose: () => settle(null),
      });
    });
  }

  async function printRolePlaySceneDiscussion() {
    const activeProject = getActiveProject();
    if (discussionSession.voice.active) { showMessage({ textId: 'player.discussion.printBusy' }); return; }
    discussionSession.bindProject(activeProject);
    if (!discussionSession.hasAnyText()) {
      showMessage({ text: translate('player.discussion.printEmpty') });
      return;
    }
    const details = await promptDiscussionPrintDetails();
    if (!details) return;
    if (discussionSession.voice.active) { showMessage({ textId: 'player.discussion.printBusy' }); return; }
    const printWindow = globalThis.open?.('', 'roleplayscene_discussion_print', 'width=960,height=720,resizable=yes,scrollbars=yes');
    if (!printWindow || !printWindow.document) {
      showMessage({ text: translate('player.discussion.printPopupBlocked') });
      return;
    }
    const model = buildDiscussionPrintModel(activeProject, discussionSession.snapshot());
    const html = buildDiscussionPrintHtml(model, {
      reportTitle: translate('player.discussion.printReportTitle'),
      dialogue: translate('player.discussion.printDialogue'),
      choices: translate('player.discussion.printChoices'),
      discussion: translate('player.discussion.printDiscussion'),
      empty: translate('player.discussion.printEmpty'),
      student: translate('player.discussion.printStudentLabel'),
      date: translate('player.discussion.printDateLabel'),
      defaultSchoolName: getDefaultDiscussionPrintSchoolName(),
    }, {
      schoolName: details.schoolName,
      studentName: details.studentName,
      printedAt: formatDiscussionPrintDate(),
    });
    try {
      printWindow.opener = null;
    } catch {
      // Printing should still work in browsers that prevent mutating opener.
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  }

  return { print: printRolePlaySceneDiscussion };
}
