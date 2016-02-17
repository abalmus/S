/// <reference path="../S.d.ts" />

declare var module : { exports : {} };
declare var define : (deps: string[], fn: () => S) => void;

(function () {
    "use strict";
    
    // "Globals" used to keep track of current system state
    var Time      = 1, // our clock, ticks every update
        Batching  = 0, // whether we're batching data changes, 0 = no, 1+ = yes, with index to next Batch slot
        Batch     = [] as DataNode<any>[], // batched changes to data nodes
        Updating  = null as ComputationNode<any>, // whether we're updating, null = no, non-null = node being updated
        Sampling  = false, // whether we're sampling signals, with no dependencies
        Disposing = false, // whether we're disposing
        Disposes  = [] as ComputationNode<any>[], // disposals to run after current batch of changes finishes
        Hold      = {}, // unique value returned by functions that are holding their current value
        Toplevel  = false; // whether a new computation should be promoted to top level 
    
    var S = <S>function S<T>(fn : () => T) : () => T {
        var parent   = Updating,
            sampling = Sampling,
            trait    = parent ? parent.trait : null,
            _fn      = trait ? trait(fn) : fn,
            node     = new ComputationNode<T>(_fn, trait),
            value    : T;
            
        Updating = node;
        Sampling = false;
        Toplevel = false;
        
        value = Batching ? _fn() : initialExecution(node, _fn);
        
        if (value !== Hold) node.value = value;
        
        if (Toplevel) Toplevel = false;
        else if (parent) (parent.children || (parent.children = [])).push(node);
        
        Updating = parent;
        Sampling = sampling;

        return function computation() {
            if (Disposing) {
                if (Batching) Disposes.push(node);
                else node.dispose();
            } else if (Updating && node.fn) {
                if (node.age === Time && node.marks !== node.updates) {
                    backtrack(node);
                }
                if (!Sampling) {
                    if (!node.emitter) node.emitter = new Emitter(node);
                    addEdge(node.emitter, Updating);
                }
            }
            return node.value;
        }
    }
    
    function initialExecution<T>(node : ComputationNode<T>, fn : () => T) {
        var result : T;
        
        Time++;
        Batching = 1;
            
        try {
            result = fn();
    
            if (Batching > 1) resolve(null);
        } finally {
            Updating = null;
            Sampling = false;
            Batching = 0;
        }
        
        return result;
    }
        
    S.on = function on<T>(ev : () => any, fn : () => T, seed? : T, state? : any) {
        var first = true;
        
        fn = arguments.length <= 2 ? fn :
            arguments.length === 3 ? reduce(seed)(fn) :
            reduce2(seed, state)(fn);
        
        return S(on);
        
        function on() : T { 
            ev(); 
            return first ? (first = false, seed) : S.sample(fn);
        }
    };

    S.data = function data<T>(value : T) : (value? : T) => T {
        var node = new DataNode(value);

        return function data(value? : T) : T {
            if (arguments.length > 0) {
                if (Batching) {
                    if (node.age === Time) { // value has already been set once, check for conflicts
                        if (value !== node.pending) {
                            throw new Error("conflicting changes: " + value + " !== " + node.pending);
                        }
                    } else { // add to list of changes
                        node.age = Time; 
                        node.pending = value;
                        Batch[Batching++] = node;
                    }
                } else { // not batching, respond to change now
                    node.age = Time; 
                    node.value = value;
                    if (node.emitter) handleEvent(node);
                }
                return value;
            } else {
                if (Updating && !Sampling) {
                    if (!node.emitter) node.emitter = new Emitter(null);
                    addEdge(node.emitter, Updating);
                }
                return node.value;
            }
        }
    };
    
    S.sum = function sum<T>(value : T) : (update? : (value : T) => T) => T {
        var node = new DataNode(value);

        return function sum(update? : (value : T) => T) : T {
            if (arguments.length > 0) {
                if (Batching) {
                    if (node.age === Time) { // value has already been set once, update pending value
                        node.pending = update(node.pending);
                    } else { // add to list of changes
                        node.age = Time; 
                        node.pending = update(node.value);
                        Batch[Batching++] = node;
                    }
                } else { // not batching, respond to change now
                    node.age = Time; 
                    node.value = update(node.value);
                    if (node.emitter) handleEvent(node);
                }
                return value;
            } else {
                if (Updating && !Sampling) {
                    if (!node.emitter) node.emitter = new Emitter(null);
                    addEdge(node.emitter, Updating);
                }
                return node.value;
            }
        }
    };

    S.event = function event<T>(fn : () => T) : T {
        var result : T;
        
        if (Batching) {
            result = fn();
        } else {
            Batching = 1;

            try {
                result = fn();
                handleEvent(null);
            } finally {
                Batching = 0;
            }
        }
            
        return result;
    };
    
    S.sample = function sample<T>(fn : () => T) : T {
        var result : T;
        
        if (Updating && !Sampling) {
            Sampling = true;
            result = fn();
            Sampling = false;
        } else {
            result = fn();
        }
        
        return result;
    }
    
    S.hold = function hold() { return Hold; };

    S.trait = function trait<T>(mod : (fn : () => T) => () => T) : (fn : () => T) => () => T {
        return function (fn) {
            var first = true;
            fn = mod(fn);
            return function trait() {
                if (first && Updating) {
                    Updating.trait = Updating.trait ? compose(Updating.trait, mod) : mod;
                    first = false;
                } 
                return fn();
            }
        }
    }
    
    S.toplevel = function toplevel<T>(fn : () => T) : () => T {
        return function toplevel() {
            var result = fn();
            Toplevel = true;
            return result;
        }
    };

    S.async = function async<T>(scheduler : (go : () => void) => () => void) : (fn : () => T) => () => T {
        var sentinel = S.data(false),
            tick = scheduler(go);
            
        return S.trait<T>(async);
        
        function async(fn) {
            var first = true;
            return function async() {
                return first ? (first = false, fn()) :
                    S.sample(sentinel) ? (sentinel(false), fn()) : 
                    (sentinel(), tick && tick(), S.hold());
            }
        }
        
        function go() {
            sentinel(true);
        }
    }
    
    function compose(a, b) {
        return function compose(fn) { return a(b(fn)); } 
    }
    
    function reduce<T>(seed : T) : (fn : (v: T) => T) => () => T {
        var _seed = seed;
        return function reduce(fn) {
            var seed = _seed;
            return function reduce() {
                return seed = fn(seed);
            };
        };
    }
    
    function reduce2<T, U>(seed : T, state : U) : (fn : (v: T, S : U) => T) => () => T {
        var _seed = seed;
        return function (fn) {
            var seed = _seed;
            return function reduce2() {
                return seed = fn(seed, state);
            };
        };
    }

    S.dispose = function dispose(signal : () => {}) {
        if (Disposing) {
            signal();
        } else {
            Disposing = true;
            try {
                signal();
            } finally {
                Disposing = false;
            }
        }
    }
    
    S.cleanup = function cleanup(fn : () => void) : void {
        if (Updating) {
            (Updating.cleanups || (Updating.cleanups = [])).push(fn);
        } else {
            throw new Error("S.cleanup() must be called from within an S() computation.  Cannot call it at toplevel.");
        }
    };
    
    function handleEvent(change : DataNode<any>) {
        try {
            resolve(change);
        } finally {
            Batching  = 0;
            Updating  = null;
            Sampling  = false;
            Disposing = false;
        }
    }
        
    var _batch = [] as DataNode<any>[];
        
    function resolve(change : DataNode<any>) {
        var count = 0, 
            batch : DataNode<any>[], 
            i     : number, 
            len   : number;
            
        if (!Batching) Batching = 1;
            
        if (change) {
            Time++;
            
            propagate(mark, change.emitter);
            propagateMarked(update, change.emitter);
            
            if (Disposes.length) {
                for (i = 0; i < Disposes.length; i++) Disposes[i].dispose();
                Disposes = [];
            }
        }
        
        // for each batch ...
        while (Batching !== 1) {
            // prepare globals to record next batch
            Time++;
            batch = Batch, Batch = _batch, _batch = batch; // rotate batch arrays
            len = Batching, Batching = 1;
            
            // set nodes' values, clear pending data, and prepare them for update
            for (i = 1; i < len; i++) {
                change = batch[i];
                change.value = change.pending;
                change.pending = undefined;
                
                propagate(mark, change.emitter);
            }
            
            // run all updates in batch
            for (i = 1; i < len; i++) {
                change = batch[i];
                propagateMarked(update, change.emitter);
                batch[i] = null;
            }
            
            // run disposes accumulated while updating
            if (Disposes.length) {
                for (i = 0; i < Disposes.length; i++) Disposes[i].dispose();
                Disposes = [];
            }

            // if there are still changes after excessive batches, assume runaway            
            if (count++ > 1e5) {
                throw new Error("Runaway frames detected");
            }
        }
    }
    
    function mark(node: ComputationNode<any>) {
        var children = node.children;
        
        if (node.age === Time) {
            // if we've come back to an emitting Emitter, that's a cycle
            if (node.emitter && node.emitter.emitting)
                throw new Error("circular dependency"); // TODO: more helpful reporting

            node.marks++;
        } else {
            node.age     = Time;
            node.marks   = 1;
            node.updates = 0;
            
            if (children) {
                for (var i = 0; i < children.length; i++) {
                    mark(children[i]);
                }
            }
            
            propagate(mark, node.emitter);
        }
    }
    
    /// update the given node by re-executing any payload, updating inbound links, then updating all downstream nodes
    function update(node : ComputationNode<any>) {
        node.updates++;
        
        if (node.marks != node.updates) return;
        
        var receiver  = node.receiver;
        
        Updating = node;

        node.cleanup(false);
        
        var value = node.fn();
        
        if (value !== Hold) {
            node.value = value;
            
            propagateMarked(update, node.emitter);
            
            if (receiver) {
                for (var i = 0; i < receiver.edges.length; i++) {
                    var edge = receiver.edges[i];
                    if (edge.from && edge.age < Time) {
                        edge.deactivate();
                    }
                }
                
                if (receiver.fragmented()) receiver.compact();
            }
        } else {
            propagateMarked(clear, node.emitter);
        }
    }
    
    function clear(node : ComputationNode<any>) {
        node.marks--;
        if (node.marks === node.updates) {
            if (node.marks > 0) update(node);
            else {
                propagateMarked(clear, node.emitter);
                
                if (node.children) {
                    for (var i = 0; i < node.children.length; i++) {
                        clear(node.children[i]);
                    }
                }
            }
        }
    }
        
    /// update the given node by backtracking its dependencies to clean state and updating from there
    function backtrack(node : ComputationNode<any>) {
        var updating = Updating,
            sampling = Sampling;
            
        Sampling = false;
        
        backtrack(node);
        
        Updating = updating;
        Sampling = sampling;
        
        function backtrack(node : ComputationNode<any>) {
            var edges = node.receiver.edges;
            for (var i = 0; i < edges.length; i++) {
                var edge = edges[i];
                if (edge.marked) {
                    var back = edge.from.node;
                    if (!back) {
                        // reached data node, start updating
                        propagateMarked(update, edge.from);
                    } else if (back.marks === back.updates) {
                        // reached clean computation, start updating
                        update(back);
                    } else {
                        // still working backwards through the marked nodes, go back further
                        backtrack(back);
                    }
                }
            }
        }
    }
    
    function propagate(op : (node : ComputationNode<any>) => void, emitter: Emitter) : void {
        if (!emitter) return;
        var edges = emitter.edges;
        emitter.emitting = true;
        for (var i = 0; i < edges.length; i++) {
            var edge = edges[i];
            if (edge) {
                edge.marked = true;
                op(edge.to.node);
            }
        }
        emitter.emitting = false;
    }
    
    function propagateMarked(op : (node : ComputationNode<any>) => void, emitter: Emitter) : void {
        if (!emitter) return;
        var edges = emitter.edges;
        emitter.emitting = true;
        for (var i = 0; i < edges.length; i++) {
            var edge = edges[i];
            if (edge && edge.marked) {
                edge.marked = false;
                op(edge.to.node);
            }
        }
        emitter.emitting = false;
    }
    
    /// Graph classes and operations
    class DataNode<T> {
        age     = 0; // Data nodes start at a time prior to the present, or else they can't be set in the current tick
        pending : T;   
        emitter = null as Emitter;
        
        constructor(
            public value : T
        ) { }
    }
    
    class ComputationNode<T> {
        value     : T;
        
        age     = Time;
        marks   = 0;
        updates = 0;
        
        emitter   = null as Emitter;
        receiver  = null as Receiver;
        
        // children and cleanups generated by last update
        children  = null as ComputationNode<any>[];
        cleanups  = null as ((final : boolean) => void)[];
        
        constructor(
            public fn   : () => T|{}, 
            public trait : (fn : () => any) => () => any
        )  { }
        
        // dispose node: free memory, dispose children, cleanup, detach from graph
        dispose() {
            if (!this.fn) return;
            
            this.fn    = null;
            this.trait = null;
            
            if (this.age === Time && this.marks !== this.updates) {
                propagateMarked(clear, this.emitter);
            }
            
            this.cleanup(true);
            if (this.receiver) this.receiver.detach();
            if (this.emitter) this.emitter.detach();
        }
        
        cleanup(final : boolean) {
            if (this.children) {
                for (var i = 0; i < this.children.length; i++) {
                    this.children[i].dispose();
                }
                this.children = null;
            }
            
            if (this.cleanups) {
                for (i = 0; i < this.cleanups.length; i++) {
                    this.cleanups[i](final);
                }
                this.cleanups = null;
            }
        }
    }
    
    class Emitter {
        static count = 0;
        
        id       = Emitter.count++;
        emitting = false;
        edges    = [] as Edge[];
        active   = 0;
        edgesAge = 0;
        
        constructor(
            public node : ComputationNode<any>
        ) { }
    
        detach() {
            for (var i = 0; i < this.edges.length; i++) {
                var edge = this.edges[i];
                if (edge) edge.deactivate();
            }
        }
    
        fragmented() {
            return this.edges.length > 10 && this.edges.length / this.active > 4;
        }
    
        compact() {
            var edges      = [] as Edge[], 
                compaction = ++this.edgesAge;
                
            for (var i = 0; i < this.edges.length; i++) {
                var edge = this.edges[i];
                if (edge) {
                    edge.slot = edges.length;
                    edge.slotAge = compaction;
                    edges.push(edge);
                }
            }
            
            this.edges = edges;
        }
    }
    
    function addEdge(from : Emitter, to : ComputationNode<any>) {
        var edge : Edge = null;
        
        if (!to.receiver) to.receiver = new Receiver(to);
        else edge = to.receiver.index[from.id];
        
        if (edge) edge.activate(from);
        else new Edge(from, to.receiver);
    }
        
    class Receiver {
        static count = 0;
        
        id      = Emitter.count++;
        edges   = [] as Edge[];
        index   = [] as Edge[];
        active  = 0;
        
        constructor(
            public node : ComputationNode<any>
        ) { }
        
        detach() {
            for (var i = 0; i < this.edges.length; i++) {
                this.edges[i].deactivate();
            }
        }
        
        fragmented() {
            return this.edges.length > 10 && this.edges.length / this.active > 4;
        }
        
        compact() {
            var edges = [] as Edge[], 
                index = [] as Edge[];
                
            for (var i = 0; i < this.edges.length; i++) {
                var edge = this.edges[i];
                if (edge.from) {
                    edges.push(edge);
                    index[edge.from.id] = edge;
                }
            }
            
            this.edges = edges;
            this.index = index;
        }
    }

    class Edge {
        age      = Time;
        
        marked   = false;
        
        slot     : number;
        slotAge  : number;
        
        constructor(
            public from : Emitter, 
            public to : Receiver
        ) {
            this.slot = from.edges.length;
            this.slotAge = from.edgesAge;
    
            from.edges.push(this);
            to.edges.push(this);
            to.index[from.id] = this;
            from.active++;
            to.active++;
        }
        
        activate(from : Emitter) {
            if (!this.from) {
                this.from = from;
                if (this.slotAge === from.edgesAge) {
                    from.edges[this.slot] = this;
                } else {
                    this.slotAge = from.edgesAge;
                    this.slot = from.edges.length;
                    from.edges.push(this);
                }
                this.to.active++;
                from.active++;
            }
            this.age = Time;
        }
        
        deactivate() {
            if (!this.from) return;
            var from = this.from, to = this.to;
            this.from = null;
            from.edges[this.slot] = null;
            from.active--;
            to.active--;
        }
    }
        
    // UMD exporter
    /* globals define */
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = S; // CommonJS
    } else if (typeof define === 'function') {
        define([], function () { return S; }); // AMD
    } else {
        (eval || function () {})("this").S = S; // fallback to global object
    }
})();