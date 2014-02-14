// # State machine support for task.js
//
// This file contains miscellaneous state machine management code
// that is used by the code generated by the `task` macro in task.js.

function State() {
    this.id = 0;
    this.args = [null, null];
    this.err = null;
    this.unwinding = [];
    this.phi = [];
    this.installed_catches = {};
    this.waiting = 0;
    this.isFinished = false;
    this.isUnwinding = false;
    this.abort_with_error = null;
    return this;
}

function controlAPIMaker() {
    var state_machine = this;
    return Object.create({}, {
        abort: {
            value: function (err) {
                if (state_machine.state.waiting > 0) {
                    state_machine.state.abort_with_error = err;
                } else {
                    state_machine.callback(err);
                }
            }
        },
        isWaiting: {
            get: function () {
                return state_machine.state.waiting > 0;
            }
        },
        isFinished: {
            get: function () {
                return state_machine.state.isFinished;
            }
        }
    });
}

function StateMachine(context, callback, fn) {

    this.state = new State();
    this.fn = fn;
    this.context = context;
    this.finalCallback = callback;

    // The following two will be initialized if the body
    // of the state machine contains a finally {} block.
    // If not, they can remain null.
    this.captureStateVars = null; // Might be initialized to function () { return array; }
    this.restoreStateVars = null; // Might be initialized to function (array) { assign state variables; }

    this.boundStep = this.step.bind(this);
    this.boundUnwind = this.unwind.bind(this);
    this.cachedJumpTable = {};
    this.controlAPIMaker = controlAPIMaker.bind(this);

    return this;
}

StateMachine.prototype.start = function () {
    this.goTo(1);
};

StateMachine.prototype.step = function () {
    this.state.waiting--;
    if (this.state.abort_with_error) {
        this.state.abort_with_error = null;
        return this.fn.call(this.context, this.state.abort_with_error);
    }
    this.fn.apply(this.context, this.state.args);
};

StateMachine.prototype.goTo = function (id) {
    this.state.id = id;
    this.state.waiting++;
    process.nextTick(this.boundStep);
};

StateMachine.prototype.thenTo = function (id) {
    var done = false;
    var self = this;
    this.state.waiting++;
    return function () {
        var _self = self;
        var _state = _self.state;
        _state.waiting--;
        if (_state.abort_with_error) {
            return _self.fn.call(_self.context, _state.abort_with_error);
        }
        if (!done) {
            done = true;
            _state.id = id;
            _self.fn.apply(_self.context, arguments); 
        } else {
            console.error('Callback called repeatedly!');
        }
    };
};

StateMachine.prototype.callback = function (err) {
    this.state.args = Array.prototype.slice.call(arguments);
    this.state.err = err;
    process.nextTick(this.boundUnwind);
};

StateMachine.prototype.unwind = function () {
    if (this.state.unwinding.length > 0) {
        var where = this.state.unwinding.pop();
        this.state.isUnwinding = true;
        if (where.isError) {
            if (this.state.err) {
                this.goTo(where.step);
            } else {
                process.nextTick(this.boundUnwind);
            }
        } else {
            if (where.fn) {
                where.fn();
                process.nextTick(this.boundUnwind);
            } else {
                this.restoreStateVars(where.state);
                this.goTo(where.step);
            }
        }
    } else if (!this.state.isFinished) {
        this.state.waiting = 0;
        this.state.isFinished = true;
        this.finalCallback && this.finalCallback.apply(this.context, this.state.args);
    }
};

StateMachine.prototype.unwindNextTick = function () {
    process.nextTick(this.boundUnwind);
};

StateMachine.prototype.pushCleanupAction = function (context, fn, args) {
    var callbackPos = args.length;
    var self = this;
    self.state.unwinding.push({
        cleanup: true,
        fn: function () {
            fn.apply(context, args);
        }
    });
};

StateMachine.prototype.pushCleanupStep = function (id) {
    this.state.unwinding.push({cleanup: true, step: id, state: this.captureStateVars()});
};

StateMachine.prototype.pushErrorStep = function (id) {
    if (!this.state.installed_catches[id]) {
        this.state.unwinding.push({isError: true, step: id});
        this.state.installed_catches[id] = true;
    }
};

StateMachine.prototype.pushPhi = function (id) {
    this.state.phi.push(id);
};

StateMachine.prototype.phi = function () {
    this.goTo(this.state.phi.pop());
};

function JumpTable(sm, id, cases, blockSizes) {
    this.state_machine = sm;
    this.id = id;
    this.cases = cases;
    this.blockSizes = blockSizes;
    this.stepIDs = [];
    this.beyondID = id;

    var i = 0, j = 0, sum = id + 1, ci;
    for (i = 0; i < blockSizes.length; ++i) {
        ci = cases[i];
        for (j = 0; j < ci.length; ++j) {
            this.stepIDs[ci[j]] = sum;
        }
        sum += 1 + blockSizes[i]; // +1 for the additional "phi"
    }

    this.beyondID = sum;
    return this;
}

JumpTable.prototype.jumpToCase = function (caseVal) {
    this.state_machine.pushPhi(this.beyondID);
    var stepID = this.stepIDs[caseVal];
    if (!stepID) {
        throw new Error("Unhandled case '" + caseVal + "' at step " + this.id);
    }
    this.state_machine.goTo(stepID);
};

StateMachine.prototype.jumpTable = function (id, cases, blockSizes) {
    // cases[i] is an array of case values that all map
    // to the same block whose size is given by blockSizes[i].
    if (!cases) {
        return this.cachedJumpTable[id];
    }

    console.assert(cases.length === blockSizes.length);

    return this.cachedJumpTable[id] = new JumpTable(this, id, cases, blockSizes);
};


module.exports = StateMachine;
