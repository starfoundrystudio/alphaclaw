import { h } from "preact";
import htm from "htm";
import { kWelcomeGroups } from "../onboarding/welcome-config.js";
import { WelcomeHeader } from "../onboarding/welcome-header.js";
import { WelcomeSetupStep } from "../onboarding/welcome-setup-step.js";
import { WelcomeFormStep } from "../onboarding/welcome-form-step.js";
import { WelcomePairingStep } from "../onboarding/welcome-pairing-step.js";
import { useWelcome } from "./use-welcome.js";

const html = htm.bind(h);

export const Welcome = ({ onComplete, acVersion }) => {
  const { state, actions } = useWelcome({ onComplete });

  return html`
    <div class="max-w-lg w-full space-y-5">
      <${WelcomeHeader}
        groups=${kWelcomeGroups}
        step=${state.step}
        isPreStep=${state.isPreStep}
        isSetupStep=${state.isSetupStep}
        isPairingStep=${state.isPairingStep}
        stepNumber=${state.stepNumber}
        activeStepLabel=${state.activeStepLabel}
      />

      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        ${state.isSetupStep
                ? html`<${WelcomeSetupStep}
                    error=${state.setupError}
                    loading=${state.loading}
                    handoff=${state.setupHandoff}
                    onRetry=${actions.handleSubmit}
                    onBack=${actions.goBackFromSetupError}
                    onRetryHandoff=${actions.handleRetrySetupHandoff}
                    onOpenHandoff=${actions.handleOpenSetupHandoff}
                  />`
                : state.isPairingStep
                  ? html`<${WelcomePairingStep}
                      channel=${state.selectedPairingChannel}
                      pairings=${state.pairingRequestsPoll.data || []}
                      loading=${!state.pairingStatusPoll.data}
                      error=${state.pairingError}
                      onApprove=${actions.handlePairingApprove}
                      onReject=${actions.handlePairingReject}
                      canFinish=${state.pairingComplete || state.canFinishPairing}
                      onContinue=${actions.finishOnboarding}
                      onSkip=${actions.finishOnboarding}
                    />`
                  : html`
                      <${WelcomeFormStep}
                        activeGroup=${state.activeGroup}
                        vals=${state.vals}
                        hasAi=${state.hasAi}
                        setValue=${actions.setValue}
                        modelAccessMode=${state.modelAccessMode}
                        setModelAccessMode=${actions.setModelAccessMode}
                        accountLoginOptions=${state.accountLoginOptions}
                        selectedAccountLoginProvider=${state.selectedAccountLoginProvider}
                        setAccountLoginProvider=${actions.setAccountLoginProvider}
                        accountLoginNeedsSetup=${state.accountLoginNeedsSetup}
                        modelOptions=${state.modelOptions}
                        recommendedModels=${state.recommendedModels}
                        selectedModelIsRecommended=${state.selectedModelIsRecommended}
                        modelsLoading=${state.modelsLoading}
                        modelsError=${state.modelsError}
                        canToggleFullCatalog=${state.canToggleFullCatalog}
                        showAllModels=${state.showAllModels}
                        setShowAllModels=${actions.setShowAllModels}
                        selectedProvider=${state.selectedProvider}
                        codexLoading=${state.codexLoading}
                        codexStatus=${state.codexStatus}
                        startCodexAuth=${actions.startCodexAuth}
                        handleCodexDisconnect=${actions.handleCodexDisconnect}
                        codexAuthStarted=${state.codexAuthStarted}
                        codexAuthWaiting=${state.codexAuthWaiting}
                        codexManualInput=${state.codexManualInput}
                        setCodexManualInput=${actions.setCodexManualInput}
                        claudeCliStatus=${state.claudeCliStatus}
                        claudeCliLoading=${state.claudeCliLoading}
                        claudeCliActionLoading=${state.claudeCliActionLoading}
                        claudeCliLoginCanSubmitCode=${state.claudeCliLoginCanSubmitCode}
                        claudeCliLoginInput=${state.claudeCliLoginInput}
                        claudeCliLoginSubmitting=${state.claudeCliLoginSubmitting}
                        claudeCliLoginOutput=${state.claudeCliLoginOutput}
                        claudeCliLoginState=${state.claudeCliLoginState}
                        claudeCliLoginUrl=${state.claudeCliLoginUrl}
                        claudeCliLoginWindowOpened=${state.claudeCliLoginWindowOpened}
                        claudeCliError=${state.claudeCliError}
                        refreshClaudeCliStatus=${actions.refreshClaudeCliStatus}
                        startClaudeCliAuth=${actions.startClaudeCliAuth}
                        openClaudeCliLoginUrl=${actions.openClaudeCliLoginUrl}
                        setClaudeCliLoginInput=${actions.setClaudeCliLoginInput}
                        submitClaudeCliLoginCode=${actions.submitClaudeCliLoginCode}
                        adoptClaudeCliAuth=${actions.adoptClaudeCliAuth}
                        tailscaleApiToken=${state.tailscaleApiToken}
                        setTailscaleApiToken=${actions.setTailscaleApiToken}
                        tailscaleClientReady=${state.tailscaleClientReady}
                        setTailscaleClientReady=${actions.setTailscaleClientReady}
                        completeCodexAuth=${actions.completeCodexAuth}
                        codexExchanging=${state.codexExchanging}
                        visibleAiFieldKeys=${state.visibleAiFieldKeys}
                        error=${state.formError}
                        step=${state.step}
                        totalGroups=${kWelcomeGroups.length}
                        goBack=${actions.goBack}
                        goNext=${actions.goNext}
                        loading=${state.loading}
                        handleSubmit=${actions.handleSubmit}
                      />
                    `}
      </div>
      ${acVersion
        ? html`
            <div class="text-center text-xs text-fg-muted font-mono mt-8">
              v${acVersion}
            </div>
          `
        : null}
    </div>
  `;
};
