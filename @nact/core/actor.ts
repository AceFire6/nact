import { ActorSystemRef, Ref } from "./references";
import { Deferral } from './deferral';
import { applyOrThrowIfStopped } from './system-map';
import { ActorRef, TemporaryRef } from './references';
import Queue from 'denque';
import assert from './assert';
import { stop } from './functions';
import { defaultSupervisionPolicy, SupervisionActions } from './supervision';
import { ActorPath } from "./paths";
import { Milliseconds } from ".";
import { ActorSystem } from "./system";
import { addMacrotask, clearMacrotask } from './macrotask'

function unit(): void { };

export type ActorName = string;

// type InferMsgFromRef<R extends Ref<any>> = R extends Ref<infer Msg> ? Msg : never;
type ParentTypeFromRefType<P extends ActorSystemRef | ActorRef<any, any>> = P extends ActorSystemRef ? ActorSystem : (P extends ActorRef<infer Msg, infer ParentRef> ? Actor<any, Msg, ParentRef> : never);
export class Actor<State, Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> {
  parent: ParentTypeFromRefType<ParentRef>
  name: ActorName;
  path: ActorPath;
  system: ActorSystem;
  afterStop: (state: State, ctx: ActorContextWithMailbox<Msg, ParentRef>) => void | Promise<void>;
  reference: ActorRef<Msg, ParentRef>;
  f: ActorFunc<State, Msg, ParentRef>;
  stopped: boolean;
  children: Map<any, Actor<unknown, unknown, ActorRef<Msg, ParentRef>>>;
  childReferences: Map<any, ActorRef<unknown, ActorRef<Msg, ParentRef>>>;
  busy: boolean;
  mailbox: Queue<{ message: Msg }>;
  immediate: number | undefined;
  onCrash: SupervisionActorFunc<Msg, ParentRef, Ref<any>> | ((msg: any, err: any, ctx: any, child?: undefined | ActorRef<Msg, ParentRef>) => any);
  initialState: State | undefined;
  initialStateFunc: ((ctx: ActorContext<Msg, ParentRef>) => State) | undefined;
  shutdownPeriod?: Milliseconds;
  state: any;
  timeout?: Milliseconds;
  setTimeout: () => void;

  constructor(parent: ParentTypeFromRefType<ParentRef>, name: string | undefined, system: any, f: ActorFunc<State, Msg, ParentRef>, { shutdownAfter, onCrash, initialState, initialStateFunc, afterStop }: ActorProps<State, Msg, ParentRef> = {}) {
    this.parent = parent;
    if (!name) {
      name = `anonymous-${Math.abs(Math.random() * Number.MAX_SAFE_INTEGER) | 0}`;
    }
    if (parent.children.has(name)) {
      throw new Error(`child actor of name ${name} already exists`);
    }
    this.name = name;
    this.path = parent.path.createChildPath(this.name);
    this.system = system;
    this.afterStop = afterStop || (() => { });
    this.reference = new ActorRef<Msg, ParentRef>(this.system.name, this.parent.reference as ParentRef, this.path, this.name);
    this.f = f;
    this.stopped = false;
    this.children = new Map();
    this.childReferences = new Map();
    this.busy = false;
    this.mailbox = new Queue();
    this.immediate = undefined;
    this.parent.childSpawned(this);
    this.onCrash = onCrash || defaultSupervisionPolicy;
    this.initialState = initialState;
    this.initialStateFunc = initialStateFunc;
    if (shutdownAfter) {
      if (typeof (shutdownAfter) !== 'number') {
        throw new Error('Shutdown should be specified as a number in milliseconds');
      }
      this.shutdownPeriod = Actor.getSafeTimeout(shutdownAfter);
      this.setTimeout = () => {
        this.timeout = setTimeout(() => this.stop(), this.shutdownPeriod);
      };
    } else {
      this.setTimeout = unit;
    }
    this.initializeState();
    this.setTimeout();
  }

  initializeState() {
    if (this.initialStateFunc) {
      try {
        this.state = this.initialStateFunc(this.createContext());
      } catch (e) {
        this.handleFault(undefined, undefined, e);
      }
    } else {
      this.state = this.initialState;
    }
  }


  reset() {
    [...this.children.values()].forEach(x => x.stop());
    this.initializeState();
    this.resume();
  }

  clearTimeout() {
    clearTimeout(this.timeout);
  }

  clearImmediate() {
    clearMacrotask(this.immediate);
  }

  static getSafeTimeout(timeoutDuration: any) {
    timeoutDuration = timeoutDuration | 0;
    const MAX_TIMEOUT = 2147483647;
    return Math.min(MAX_TIMEOUT, timeoutDuration);
  }

  assertNotStopped() { assert(!this.stopped); return true; }
  afterMessage() { }

  dispatch(message: Msg) {
    this.assertNotStopped();
    this.clearTimeout();
    if (!this.busy) {
      this.handleMessage(message);
    } else {
      this.mailbox.push({ message });
    }
  }

  query(message: Msg, timeout: number) {
    this.assertNotStopped();
    assert(timeout !== undefined && timeout !== null);
    const deferred = new Deferral();

    timeout = Actor.getSafeTimeout(timeout);
    const timeoutHandle = setTimeout(() => { deferred.reject(new Error('Query Timeout')); }, timeout);
    const tempReference = new TemporaryRef(this.system.name);
    this.system.addTempReference(tempReference, deferred);
    deferred.promise.then(() => {
      clearTimeout(timeoutHandle);
      this.system.removeTempReference(tempReference);
    }).catch(() => {
      this.system.removeTempReference(tempReference);
    });

    if (typeof (message) === 'function') {
      message = message(tempReference);
    }
    this.dispatch(message);
    return deferred.promise;
  }

  childStopped(child: Actor<unknown, unknown, any>) {
    this.children.delete(child.name);
    this.childReferences.delete(child.name);
  }

  childSpawned(child: Actor<any, any, any>) {
    this.children.set(child.name, child);
    this.childReferences.set(child.name, child.reference);
  }

  stop() {
    const context = this.createContextWithMailbox();

    this.clearImmediate();
    this.clearTimeout();
    this.parent.childStopped(this);
    delete (this as any).parent;
    [...this.children.values()].forEach(stop);
    this.stopped = true;

    addMacrotask(() => this.afterStop(this.state, context));
  }

  processNext() {
    if (!this.stopped) {
      const nextMsg = this.mailbox.shift();
      if (nextMsg) {
        this.handleMessage(nextMsg.message);
      } else {
        this.busy = false;
        // Counter is now ticking until actor is killed
        this.setTimeout();
      }
    }
  }

  async handleFault(msg: undefined | Msg, error: Error | undefined, child: undefined | ActorRef<any, any> = undefined) {
    const ctx = this.createSupervisionContext();
    const decision = await Promise.resolve(this.onCrash(msg, error, ctx, child));
    switch (decision) {
      // Stop Self
      case SupervisionActions.stop:
        this.stop();
        break;
      // Stop Self and Peers
      case SupervisionActions.stopAll:
        [...this.parent.children.values()].forEach(x => x.stop());
        break;
      // Stop Child
      case SupervisionActions.stopChild:
        assert(child, 'Expected child');
        this.children.get(child.name)?.stop();
        break;
      // Stop All Children
      case SupervisionActions.stopAllChildren:
        [...this.children.values()].forEach(x => x.stop());
        break;
      // Resume
      case SupervisionActions.resume:
        this.resume();
        break;
      // Reset Self
      case SupervisionActions.reset:
        this.reset();
        break;
      // Reset Self and Peers
      case SupervisionActions.resetAll:
        [...this.parent.children.values()].forEach(x => x.reset());
        break;
      // Reset Child
      case SupervisionActions.resetChild:
        assert(child, 'Expected child');
        this.children.get(child.name)?.reset();
        break;
      // Reset all Children
      case SupervisionActions.resetAllChildren:
        [...this.children.values()].forEach(x => x.reset());
        break;
      // Escalate to Parent
      case SupervisionActions.escalate:
      default:
        this.parent.handleFault(msg, error, this.reference);
        break;
    }
  }

  resume() {
    this.processNext();
  }

  createSupervisionContext() {
    const ctx = this.createContextWithMailbox();
    return { ...ctx, ...SupervisionActions };
  }

  createContextWithMailbox() {
    const ctx = this.createContext();
    return { ...ctx, mailbox: this.mailbox.toArray() };
  }

  createContext(): ActorContext<Msg, ParentRef> {
    return {
      parent: this.parent.reference as ParentRef,
      path: this.path,
      self: this.reference,
      name: this.name,
      children: new Map(this.childReferences),
    };
  }

  handleMessage(message: Msg) {
    this.busy = true;
    this.immediate = addMacrotask(async () => {
      try {
        let ctx = this.createContext();
        let next = await Promise.resolve(this.f.call(ctx, this.state, message, ctx));
        this.state = next;
        this.afterMessage();
        this.processNext();
      } catch (e) {
        this.handleFault(message, e);
      }
    });
  }
}


// Contexts
export type ActorContext<Msg, ParentRef extends Ref<any>> = {
  parent: ParentRef,
  path: ActorPath,
  self: Ref<Msg>,
  name: ActorName,
  children: Map<ActorName, Ref<unknown>>,
};

// export type PersistentActorContext<Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> =
//   ActorContext<MSGesture, ParentRef> & { persist: (msg: Msg) => Promise<void> };


export type Mailbox<Msg> = { message: Msg }[];
export type ActorContextWithMailbox<Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> = ActorContext<Msg, ParentRef> & { mailbox: Mailbox<Msg> };

export type SupervisionContext<Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> = ActorContextWithMailbox<Msg, ParentRef> & {
  stop: Symbol,
  stopAll: Symbol,
  stopChild: Symbol,
  stopAllChildren: Symbol,
  escalate: Symbol,
  resume: Symbol,
  reset: Symbol,
  resetAll: Symbol,
  resetChild: Symbol,
  resetAllChildren: Symbol,
  mailbox: Msg[]
};

// Functions
export type ActorFunc<State, Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> = (state: State, msg: Msg, ctx: ActorContext<Msg, ParentRef>) =>
  State | Promise<State>;

export type StatelessActorFunc<Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> = (msg: Msg, ctx: ActorContext<Msg, ParentRef>) => any;


export type SupervisionActorFunc<Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>, ChildRef extends Ref<any>> = (msg: Msg | undefined, err: Error | undefined, ctx: SupervisionContext<Msg, ParentRef>, child: ChildRef | undefined) => Symbol | Promise<Symbol>;

// Inference helpers
type InferMsgFromFunc<T extends ActorFunc<any, any, any>> = T extends ActorFunc<any, infer Msg, any> ? Msg : never;
type InferStateFromFunc<T extends ActorFunc<any, any, any>> = T extends ActorFunc<infer State, any, any> ? State : never;

type InferMsgFromStatelessFunc<T extends StatelessActorFunc<any, any>> = T extends StatelessActorFunc<infer Msg, any> ? Msg : never;

// Props
export type NumberOfMessages = number;
export type Json = unknown;

export type ActorProps<State, Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> = {
  shutdownAfter?: Milliseconds,
  onCrash?: SupervisionActorFunc<Msg, ParentRef, Ref<any>>,
  initialState?: State,
  initialStateFunc?: (ctx: ActorContext<Msg, ParentRef>) => State,
  afterStop?: (state: State, ctx: ActorContextWithMailbox<Msg, ParentRef>) => void | Promise<void>
};

export type StatelessActorProps<Msg, ParentRef extends ActorSystemRef | ActorRef<any, any>> = Omit<ActorProps<any, Msg, ParentRef>, 'initialState' | 'initialStateFunc' | 'afterStop'>;


export function spawn<ParentRef extends ActorSystemRef | ActorRef<any, any>, Func extends ActorFunc<any, any, ParentRef>>(
  parent: ParentRef,
  f: Func,
  name?: string,
  properties?: ActorProps<InferStateFromFunc<Func>, InferMsgFromFunc<Func>, ParentRef>
): Ref<InferMsgFromFunc<Func>> {
  return applyOrThrowIfStopped(parent, (p: ParentTypeFromRefType<ParentRef>) => p.assertNotStopped() && new Actor(p, name, p.system, f, properties).reference);
}

export function spawnStateless<ParentRef extends ActorSystemRef | ActorRef<any, any>, Func extends StatelessActorFunc<any, ParentRef>>(
  parent: ParentRef,
  f: Func,
  name?: any,
  properties?: StatelessActorProps<InferMsgFromStatelessFunc<Func>, ParentRef>
): Ref<InferMsgFromStatelessFunc<Func>> {
  return spawn(
    parent,
    (_state: undefined, msg: InferMsgFromStatelessFunc<Func>, ctx: ActorContext<InferMsgFromStatelessFunc<Func>, ParentRef>): undefined => {
      f.call(ctx, msg, ctx);
      return undefined;
    },
    name,
    { ...properties, onCrash: (_, __, ctx) => ctx.resume }
  );
}

