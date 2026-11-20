/** Executes durable ordered workflow steps without holding SQLite across I/O. */
export class ActionsRunner {
  constructor({ actions, transports, logger = console }) {
    Object.assign(this, { actions, transports, logger });
    this.running = false; this.stopping = false; this.requested = false; this.started = false;
  }
  start() {
    if (this.started) return;
    this.started = true; this.stopping = false; this.actions.recoverRunningSteps();
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref?.();
    return this.wake();
  }
  wake() {
    if (this.stopping) return this.active;
    this.requested = true;
    if (!this.running) {
      this.running = true;
      this.active = Promise.resolve().then(() => this.drain()).catch(() => { this.logger.error?.({ error: 'An action scheduler operation failed.' }); }).finally(() => { this.running = false; if (this.requested && !this.stopping) this.wake(); });
    }
    return this.active;
  }
  async tick() { return this.wake(); }
  async drain() {
    do {
      this.requested = false;
      this.actions.resumeDue();
      let processed = 0, claim;
      while (!this.stopping && (claim = this.actions.claimNext())) {
        await this.execute(claim);
        if (++processed % 25 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    } while (this.requested && !this.stopping);
  }
  async execute({ run, step }) {
    const { id } = run, index = step.step_index, claim = step.claim_token;
    try {
      const user = this.actions.desk.user(run.created_by);
      if (!user?.active) throw Object.assign(new Error('The action creator no longer has active workspace access.'), { blocked: true, safeMessage: 'The action creator no longer has active workspace access.' });
      const config = step.config;
      if (step.type === 'task') {
        const assignee = this.actions.desk.listTechnicians().find(person => person.active && person.email.toLowerCase() === config.assignee_email.toLowerCase());
        if (!assignee) throw Object.assign(new Error('The assigned technician is no longer active.'), { blocked: true, safeMessage: 'The assigned technician is no longer active. Start a new action with an active assignee.' });
        this.actions.waitStep(id, index, claim, 'waiting_task');
      } else if (step.type === 'delay') {
        this.actions.waitStep(id, index, claim, 'waiting_delay', { due_at: new Date(Date.now() + config.minutes * 60000).toISOString() });
      } else if (step.type === 'email') {
        if (!this.transports.capabilities(user).email.configured) throw Object.assign(new Error('Outbound email is not configured.'), { blocked: true, safeMessage: 'Outbound email is not configured. Ask an administrator to configure SMTP before retrying.' });
        const result = await this.transports.sendEmail({ to: config.to, subject: config.subject, text: config.body, messageId: `<action-${id}-${step.id}@assetdesk.local>` });
        this.actions.advanceStep(id, index, claim, { recipient: config.to, messageId: result.messageId });
      } else if (step.type === 'approval') {
        const capabilities = this.transports.capabilities(user);
        if (!capabilities.approval.configured || !capabilities.publicUrl) throw Object.assign(new Error('Approval delivery is not configured.'), { blocked: true, safeMessage: 'Approval delivery requires outbound SMTP and a public AssetDesk URL. Ask an administrator to configure them before retrying.' });
        const approval = this.actions.createApproval(id, index, claim, config); if (!approval) return;
        const link = `${capabilities.publicUrl.replace(/\/$/, '')}/approve/${approval.token}`;
        await this.transports.sendEmail({ to: config.to, subject: config.subject, text: `${config.body}\n\nReview this request and explicitly approve or reject it:\n${link}\n\nThis review link expires at ${approval.expires_at}. Replies to this email do not record an approval.`, messageId: `<action-${id}-${step.id}@assetdesk.local>` });
        this.actions.markApprovalSent(id, index, claim, approval.id);
      } else if (step.type === 'api') {
        const result = await this.transports.callApi(config, user);
        this.actions.advanceStep(id, index, claim, { status: result.status });
      } else if (step.type === 'power_automate') {
        const result = await this.transports.triggerFlow(config, user);
        this.actions.advanceStep(id, index, claim, { status: result.status, trigger_accepted: true });
      } else throw Object.assign(new Error('Unsupported action step.'), { blocked: true, safeMessage: 'This action step type is not supported.' });
    } catch (error) {
      const state = error.uncertain ? 'needs_attention' : error.blocked ? 'blocked' : 'failed';
      const message = error.safeMessage || (state === 'needs_attention' ? 'The destination may have received this attempt. Check it before explicitly retrying.' : 'The action step could not be completed. Check the connection and retry.');
      this.actions.failStep(id, index, claim, state, message);
    }
  }
  async stop() { this.stopping = true; this.requested = false; clearInterval(this.timer); await this.active; }
}
