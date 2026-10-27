// A reply to an owner command that is not a failure and needs no offer (task-65.1). Its own module so the transport
// (manager-telegram.ts) and the assistant chat (manager-assistant-chat.ts) can test for it without a value import of
// manager.ts, which imports them (a circular import).

/**
 * A reply to an owner command that is not a failure and needs no offer, for example a /set whose value is already in
 * effect. Thrown by ManagerCommands.propose before anything is journaled; the transport sends its text as it is.
 */
export class ManagerNotice extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerNotice';
  }
}
