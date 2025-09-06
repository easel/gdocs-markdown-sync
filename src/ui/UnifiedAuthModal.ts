import { Modal, Notice } from 'obsidian';

/**
 * Modal for unified OAuth authentication flow
 * Displays instructions and collects authorization code from user
 * Assumes browser opened successfully by default, with fallback options
 */
export class UnifiedAuthModal extends Modal {
  private authUrl: string;
  private onAuthCode: (code: string) => void;

  constructor(app: any, authUrl: string, onAuthCode: (code: string) => void) {
    super(app);
    this.authUrl = authUrl;
    this.onAuthCode = onAuthCode;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Complete Authentication' });

    // Primary instructions assuming browser opened
    const primaryInstructions = contentEl.createDiv({ cls: 'auth-primary-instructions' });
    primaryInstructions.createEl('p', {
      text: 'Complete the Google authentication in your browser, then paste the authorization code below:',
    });

    // Auth code input (primary focus)
    const codeContainer = contentEl.createDiv({ cls: 'auth-code-container' });
    codeContainer.createEl('label', { text: 'Authorization Code:' });

    const codeInput = codeContainer.createEl('input', {
      type: 'text',
      placeholder: 'Paste your authorization code here...',
      cls: 'auth-code-input',
    });

    // Progress indicator
    const statusDiv = contentEl.createDiv({ cls: 'auth-status' });

    // Main action buttons
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const submitButton = buttonContainer.createEl('button', {
      text: 'Authenticate',
      cls: 'mod-cta',
    });
    submitButton.onclick = () => {
      const code = codeInput.value.trim();
      if (!code) {
        statusDiv.setText('Please enter the authorization code');
        statusDiv.className = 'auth-status error';
        return;
      }

      statusDiv.setText('Processing...');
      statusDiv.className = 'auth-status processing';

      this.onAuthCode(code);
      this.close();
    };

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.onclick = () => this.close();

    // Fallback section for "browser didn't open" scenario
    const fallbackSection = contentEl.createEl('details', { cls: 'auth-fallback-section' });
    fallbackSection.createEl('summary', {
      text: "Browser didn't open? Click here for manual steps",
      cls: 'auth-fallback-toggle',
    });

    const fallbackContent = fallbackSection.createDiv({ cls: 'auth-fallback-content' });

    // Copy login link button (left-aligned, secondary)
    const linkContainer = fallbackContent.createDiv({ cls: 'auth-link-container' });
    const copyLinkButton = linkContainer.createEl('button', {
      text: 'Copy Login Link',
      cls: 'auth-copy-link-btn',
    });
    copyLinkButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.authUrl);
        new Notice('Authentication URL copied to clipboard!');
      } catch (error) {
        // Fallback: show URL for manual selection
        const urlDisplay = linkContainer.createEl('textarea', {
          cls: 'auth-url-display',
          attr: { readonly: 'true' },
        });
        urlDisplay.value = this.authUrl;
        urlDisplay.rows = 4;
        urlDisplay.select();
        new Notice('URL shown below - select and copy manually');
      }
    };

    linkContainer.createEl('p', {
      text: 'Copy this link and open it manually in your browser to complete authentication',
      cls: 'auth-link-explanation',
    });

    // Manual steps
    const manualSteps = fallbackContent.createEl('div', { cls: 'auth-manual-steps' });
    manualSteps.createEl('h4', { text: 'Manual Authentication Steps:' });
    const stepsList = manualSteps.createEl('ol');
    stepsList.createEl('li', { text: 'Click "Copy Login Link" above' });
    stepsList.createEl('li', { text: 'Open the link in your browser' });
    stepsList.createEl('li', { text: 'Sign in to Google and authorize access' });
    stepsList.createEl('li', { text: 'Copy the authorization code from the success page' });
    stepsList.createEl('li', { text: 'Paste it in the field above and click "Authenticate"' });

    // Focus on input by default
    setTimeout(() => codeInput.focus(), 100);
  }
}
