// import { debuglog as dlog } from '../util'
import { ByteStr, asciiByteStr } from '../bytestr'
import { Num, numIsZero } from '../num'
import { Pos, NoPos } from '../pos'
import { Config } from './config'
import { Op } from './op'
import { ops, opinfo, fmtop } from "./ops"
import {
  BasicType,
  NumType,
  FunType,

  t_nil,
  t_bool,
  t_u8,
  t_i8,
  t_u16,
  t_i16,
  t_u32,
  t_i32,
  t_u64,
  t_i64,
  t_f32,
  t_f64,
} from '../types'
import { postorder } from './postorder'
import { Register } from './reg'
import { LocalSlot } from './localslot'
import { LoopNest, loopnest } from './loopnest'
import { dominators } from "./dom"
import { BlockTree } from "./blocktree"


const byteStr_main = asciiByteStr("main")
const byteStr_anonfun = asciiByteStr("anonfun")


export type ID = int

// Location is the storage location of a value. Either a register or stack
// slot.
export type Location = Register | LocalSlot


// Aux is an auxiliary value of Value
//
export type Aux = ByteStr | Uint8Array | BasicType


// Value is a three-address-code operation
//
export class Value {
  id      :ID    // unique identifier
  pos     :Pos = NoPos  // source position
  op      :Op    // operation that computes this value
  type    :BasicType
  b       :Block // containing block
  aux     :Aux|null // auxiliary info for this value
  auxInt  :Num      // auxiliary integer info for this value
  args    :Value[] = [] // arguments of this value
  comment :string = ''  // human readable short comment for IR formatting
  prevv   :Value|null = null // previous value (list link)
  nextv   :Value|null = null // next value (list link)
  reg     :Register|null = null  // allocated register

  uses  :int = 0 // use count. Each appearance in args or b.control counts once
  // users = new Set<Value|Block>()


  constructor(id :ID, b :Block, op :Op, type :BasicType, auxInt :Num, aux :Aux|null) {
    this.id = id
    this.op = op
    this.type = type
    this.b = b
    this.auxInt = auxInt
    this.aux = aux
    assert(type instanceof BasicType)
    // assert(type.mem > 0, `ir.Value assigned abstract type ${type}`)
  }

  // clone returns a new value that is a clean copy of the receiver.
  // The returned clone will have zero uses and null linked-list links.
  clone() :Value {
    const a = this
    const b = new Value(a.b.f.newValueID(), a.b, a.op, a.type, a.auxInt, a.aux)
    b.pos     = a.pos
    b.b       = a.b
    b.args    = a.args.slice()
    b.comment = a.comment
    b.reg     = a.reg
    for (let u of a.args) {
      u.uses++
    }
    return b
  }

  toString() {
    return 'v' + this.id
  }

  auxIsZero() :bool {
    return numIsZero(this.auxInt)
  }

  reset(op :Op) {
    const v = this
    v.op = op
    // if (op != ops.Copy && notStmtBoundary(op)) {
    //   // Special case for OpCopy because of how it is used in rewrite
    //   v.pos = posWithNotStmt(v.pos)
    // }
    v.resetArgs()
    v.auxInt = 0
    v.aux = null
  }

  setArgs1(a :Value) {
    this.resetArgs()
    this.addArg(a)
  }

  setArg(i :int, v :Value) {
    assert(this.args[i], `setArg on null slot ${i}`)
    this.args[i].uses--
    this.args[i] = v
    v.uses++
  }

  removeArg(i :int) {
    let v = this.args[i]
    // v.users.delete(this)
    v.uses--
    this.args.splice(i, 1)
  }

  resetArgs() {
    for (let a of this.args) {
      a.uses--
    }
    this.args.length = 0
  }

  addArg(v :Value) {
    assert(v !== this, `using self as arg to self`)
    v.uses++
    // v.users.add(this)
    this.args.push(v)
  }

  // rematerializeable reports whether a register allocator should recompute
  // a value instead of spilling/restoring it.
  rematerializeable() :bool {
    if (!opinfo[this.op].rematerializeable) {
      return false
    }
    for (let a of this.args) {
      // SP and SB (generated by ops.SP and ops.SB) are always available.
      if (a.op !== ops.SP && a.op !== ops.SB) {
        return false
      }
    }
    return true
  }

  addComment(comment :string) {
    if (this.comment.length > 0) {
      this.comment += "; " + comment
    } else {
      this.comment = comment
    }
  }
}


// Edge represents a CFG edge.
// Example edges for b branching to either c or d.
// (c and d have other predecessors.)
//   b.Succs = [{c,3}, {d,1}]
//   c.Preds = [?, ?, ?, {b,0}]
//   d.Preds = [?, {b,1}, ?]
// These indexes allow us to edit the CFG in constant time.
// In addition, it informs phi ops in degenerate cases like:
// b:
//    if k then c else c
// c:
//    v = Phi(x, y)
// Then the indexes tell you whether x is chosen from
// the if or else branch from b.
//   b.Succs = [{c,0},{c,1}]
//   c.Preds = [{b,0},{b,1}]
// means x is chosen if k is true.
export class Edge {
  // block edge goes to (in a succs list) or from (in a preds list)
  block :Block

  // index of reverse edge.  Invariant:
  //   e := x.succs[idx]
  //   e.block.preds[e.index] = Edge(x, idx)
  // and similarly for predecessors.
  index :int

  constructor(block :Block, index :int) {
    this.block = block
    this.index = index
  }
}


// BlockKind denotes what specific kind a block is
//
//     kind       control (x)    successors     notes
//     ---------- -------------- -------------- --------
//     Plain      (nil)          [next]         e.g. "goto"
//     If         boolean        [then, else]
//     Ret        memory         []
//
//     First      boolean        [always, never]
//
//       BlockKind.First is used by optimizer to mark otherwise conditional
//       branches as always taking a certain path.
//
//       For instance, say we have this:
//
//       foo ()->int
//         b0:
//           v0 = ConstI32 <i32> [0]
//           v1 = ConstI32 <i32> [1]
//           v2 = ConstI32 <i32> [2]
//         if v0 -> b1, b2
//         b1:
//           v3 = Copy <i32> v1
//         cont -> b3
//         b2:
//           v4 = Copy <i32> v2
//         cont -> b3
//         b1:
//           v5 = Phi v3 v4
//         ret
//
//       Now, b0's control will always route us to b1 and never b2,
//       since v0 is constant "1".
//       The optimizer may rewrite b0 as kind==First; information that
//       a later "deadcode" pass will use to eliminate b1 and its values:
//
//       foo ()->int
//         b0:
//           v0 = ConstI32 <i32> [0]
//           v1 = ConstI32 <i32> [1]
//           v2 = ConstI32 <i32> [2]
//         first v0 -> b1, b2
//         b1:
//           v3 = Copy <i32> v1
//         cont -> b3
//         b2:
//           v4 = Copy <i32> v2
//         cont -> b3
//         b1:
//           v5 = Phi v3 v4
//         ret
//
//       After the optimizer pipeline is done, the code will have been
//       reduced to simply:
//
//       foo ()->int
//         b0:
//           v1 = ConstI32 <i32> [1]
//         ret
//
//
export enum BlockKind {
  Invalid = 0,
  Plain,    // a single successor
  If,       // 2 successors, if control goto succs[0] else goto succs[1]
  Ret,      // no successors, control value is memory result
  First,    // 2 successors, always takes the first one (second is dead)
}

export enum BranchPrediction {
  Unlikely = -1,
  Unknown  = 0,
  Likely   = 1,
}

// Block represents a basic block
//
export class Block {
  id       :ID
  pos      :Pos = NoPos  // source position
  kind     :BlockKind = BlockKind.Invalid // The kind of block
  succs    :Block[] = []  // Successor/subsequent blocks (CFG)
  preds    :Block[] = []  // Predecessors (CFG)
  control  :Value|null = null
    // A value that determines how the block is exited. Its value depends
    // on the kind of the block. For instance, a BlockKind.If has a boolean
    // control value and BlockKind.Exit has a memory control value.

  f :Fun // containing function

  values  :Value[] = [] // three-address code values
  sealed  :bool = false // true if no further predecessors will be added
  comment :string = '' // human readable short comment for IR formatting

  // Likely direction for branches.
  // If BranchLikely, succs[0] is the most likely branch taken.
  // If BranchUnlikely, succs[1] is the most likely branch taken.
  // Ignored if succs.length < 2.
  // Fatal if not BranchUnknown and succs.length > 2.
  likely :BranchPrediction = BranchPrediction.Unknown

  constructor(kind :BlockKind, id :ID, f :Fun) {
    this.kind = kind
    this.id = id
    this.f = f
  }

  // pushValueFront adds v to the top of the block
  //
  pushValueFront(v :Value) {
    this.values.unshift(v)
  }

  // insertValue inserts v before refv
  //
  insertValue(refv :Value, v :Value) {
    let i = this.values.indexOf(refv)
    assert(i != -1)
    this.values.splice(i, 0, v)
  }

  // insertValue inserts v after refv
  //
  insertValueAfter(refv :Value, v :Value) {
    let i = this.values.indexOf(refv)
    assert(i != -1)
    this.values.splice(i + 1, 0, v)
  }

  // removeValue removes all uses of v
  //
  removeValue(v :Value) :int {
    let count = 0
    for (let i = 0; i < this.values.length; ) {
      if (this.values[i] === v) {
        this.values.splice(i, 1)
        assert(v.prevv !== v)
        assert(v.nextv !== v)
        if (v.prevv) { v.prevv.nextv = v.nextv }
        if (v.nextv) { v.nextv.prevv = v.prevv }
        v.uses--
      } else {
        i++
      }
    }
    if (count) {
      this.f.freeValue(v)
    }
    return count
  }

  // // replaceValue replaces all uses of existingv value with newv
  // //
  // replaceValue(existingv :Value, newv :Value) {
  //   assert(existingv !== newv, 'trying to replace V with V')

  //   // TODO: there must be a better way to replace values and retain their
  //   // edges with users.

  //   // for (let user of existingv.users) {
  //   //   assert(user !== newv,
  //   //     `TODO user==newv (newv=${newv} existingv=${existingv}) -- CYCLIC USE!`)

  //   //   for (let i = 0; i < user.args.length; i++) {
  //   //     if (user.args[i] === existingv) {
  //   //       dlog(`replace ${existingv} in user ${user} with ${newv}`)
  //   //       user.args[i] = newv
  //   //       newv.users.add(user)
  //   //       newv.uses++
  //   //       existingv.uses--
  //   //     }
  //   //   }
  //   // }
  //   // existingv.users.clear()

  //   // Remove self.
  //   // Note that we don't decrement this.uses since the definition
  //   // site doesn't count toward "uses".
  //   this.f.freeValue(existingv)

  //   // clear block pointer.
  //   // Note: "uses" does not count for the value's ref to its block, so
  //   // we don't decrement this.uses here.
  //   ;(existingv as any).b = null
  // }

  setControl(v :Value|null) {
    let existing = this.control
    if (existing) {
      existing.uses--
      // existing.users.delete(this)
    }
    this.control = v
    if (v) {
      v.uses++
      // v.users.add(this)
    }
  }

  // removePred removes the ith input edge e from b.
  // It is the responsibility of the caller to remove the corresponding
  // successor edge.
  //
  removePred(i :int) {
    this.preds.splice(i, 1)
    this.f.invalidateCFG()
  }

  // removeSucc removes the ith output edge from b.
  // It is the responsibility of the caller to remove
  // the corresponding predecessor edge.
  removeSucc(i :int) {
    this.succs.splice(i, 1)
    this.f.invalidateCFG()
  }

  // addEdgeTo adds an edge from this block to successor block b.
  // Used during building of the SSA graph; do not use on an already-completed SSA graph.
  addEdgeTo(b :Block) {
    assert(!b.sealed, `cannot modify ${b}.preds after ${b} was sealed`)
    // let i = this.succs.length
    // let j = b.preds.length
    // this.succs.push(new Edge(b, j))
    // b.preds.push(new Edge(this, i))
    this.succs.push(b)
    b.preds.push(this)
    this.f.invalidateCFG()
  }

  // // Like removeNthPred but takes a block reference and returns the index
  // // of that block as it was in this.preds
  // //
  // removePred(e :Block) :int {
  //   let i = this.preds.indexOf(e)
  //   assert(i > -1, `${e} not a predecessor of ${this}`)
  //   this.removeNthPred(i)
  //   return i
  // }

  // // Like removeNthSucc but takes a block reference and returns the index
  // // of that block as it was in this.succs
  // //
  // removeSucc(s :Block) :int {
  //   let i = this.succs.indexOf(s)
  //   assert(i > -1, `${s} not a successor of ${this}`)
  //   this.removeNthSucc(i)
  //   return i
  // }

  newPhi(t :BasicType) :Value {
    let v = this.f.newValue(this, ops.Phi, t, 0, null)
    if (this.values.length > 0 && this.values[this.values.length-1].op != ops.Phi) {
      this.values.unshift(v)
    } else {
      this.values.push(v)
    }
    return v
  }

  // newValue0 return a value with no args
  newValue0(op :Op, t :BasicType|null = null, auxInt :Num = 0, aux :Aux|null = null) :Value {
    let v = this.f.newValue(this, op, t, auxInt, aux)
    this.values.push(v)
    return v
  }

  // newValue1 returns a new value in the block with one argument
  newValue1(op :Op, t :BasicType|null, arg0 :Value, auxInt :Num = 0, aux :Aux|null = null) :Value {
    let v = this.f.newValue(this, op, t, auxInt, aux)
    v.args = [arg0]
    arg0.uses++ //; arg0.users.add(v)
    this.values.push(v)
    return v
  }

  newValue1NoAdd(op :Op, t :BasicType|null, arg0 :Value, auxInt :Num, aux :Aux|null) :Value {
    let v = this.f.newValue(this, op, t, auxInt, aux)
    v.args = [arg0]
    arg0.uses++ //; arg0.users.add(v)
    return v
  }

  // newValue2 returns a new value in the block with two arguments
  newValue2(
    op :Op,
    t :BasicType|null,
    arg0 :Value,
    arg1 :Value,
    auxInt :Num = 0,
    aux :Aux|null = null,
  ) :Value {
    let v = this.f.newValue(this, op, t, auxInt, aux)
    v.args = [arg0, arg1]
    arg0.uses++ //; arg0.users.add(v)
    arg1.uses++ //; arg1.users.add(v)
    this.values.push(v)
    return v
  }

  // newValue3 returns a new value in the block with three arguments
  newValue3(
    op :Op,
    t :BasicType|null,
    arg0 :Value,
    arg1 :Value,
    arg2 :Value,
    auxInt :Num = 0,
    aux :Aux|null = null,
  ) :Value {
    let v = this.f.newValue(this, op, t, auxInt, aux)
    v.args = [arg0, arg1, arg2]
    arg0.uses++ //; arg0.users.add(v)
    arg1.uses++ //; arg1.users.add(v)
    arg2.uses++ //; arg2.users.add(v)
    this.values.push(v)
    return v
  }

  containsCall() :bool {
    for (let v of this.values) {
      if (opinfo[v.op].call) {
        return true
      }
    }
    return false
  }

  toString() :string {
    return 'b' + this.id
  }
}


export interface NamedValueEnt {
  local  :LocalSlot
  values :Value[]
}


export class Fun {
  config :Config
  entry  :Block
  blocks :Block[]
  type   :FunType
  name   :ByteStr
  pos    :Pos = NoPos  // source position (start)
  nargs  :int      // number of arguments

  bid    :ID = 0  // block ID allocator
  vid    :ID = 0  // value ID allocator

  consts :Map<Op,Map<Num,Value>> | null = null  // constants cache

  // map from LocalSlot to set of Values that we want to store in that slot.
  namedValues = new Map<string,NamedValueEnt>()

  // when register allocation is done, maps value ids to locations
  regAlloc :Location[]|null = null

  // Cached CFG data
  _cachedPostorder :Block[]|null = null
  _cachedLoopnest  :LoopNest|null = null
  _cachedIdom      :(Block|null)[]|null = null    // cached immediate dominators
  _cachedSdom      :BlockTree|null = null // cached dominator tree


  constructor(config :Config, type :FunType, name :ByteStr|null, nargs :int) {
    this.config = config
    this.entry = new Block(BlockKind.Plain, this.bid++, this)
    this.blocks = [this.entry]
    this.type = type
    this.name = name || byteStr_anonfun
    this.nargs = nargs
  }

  newBlock(k :BlockKind) :Block {
    let b = this.newBlockNoAdd(k)
    this.blocks.push(b)
    return b
  }

  newBlockNoAdd(k :BlockKind) :Block {
    assert(this.bid < 0xFFFFFFFF, "too many block IDs generated")
    return new Block(k, this.bid++, this)
  }

  freeBlock(b :Block) {
    assert(b.f != null, `trying to free an already freed block ${b}`)
    b.f = null as any as Fun
    // TODO: put into free list
  }

  newValue(b :Block, op :Op, t :BasicType|null, auxInt :Num, aux :Aux|null) :Value {
    assert(this.vid < 0xFFFFFFFF, "too many value IDs generated")
    // TODO we could use a free list and return values when they die
    assert(opinfo[op] !== undefined, `no opinfo for op ${op}`)

    // assert(
    //   !t ||
    //   !opinfo[op].type ||
    //   opinfo[op].type!.mem == 0 ||
    //   t === opinfo[op].type,
    //   `op ${fmtop(op)} with different concrete type ` +
    //   `(op.type=${opinfo[op].type}, t=${t})`
    // )

    return new Value(
      this.vid++,
      b,
      op,
      t || opinfo[op].type || t_nil,
      auxInt,
      aux
    )
  }

  newValueNoBlock(op :Op, t :BasicType|null, auxInt :Num, aux :Aux|null) :Value {
    return this.newValue(null as any as Block, op, t, auxInt, aux)
  }

  newValueID() :ID {
    return this.vid++
  }

  freeValue(v :Value) {
    assert(v.b, `trying to free an already freed value ${v}`)
    assert(v.uses == 0, `value ${v} still has ${v.uses} uses`)
    assert(v.args.length == 0, `value ${v} still has ${v.args.length} args`)
    // TODO: put into free list
  }

  // constVal returns a constant Value representing c for type t
  //
  constVal(t :NumType, c :Num) :Value {
    let f = this

    // Select operation based on type
    let op :Op = ops.Invalid
    switch (t) {
      case t_bool:             op = ops.ConstBool; break
      case t_u8:  case t_i8:   op = ops.ConstI8; break
      case t_u16: case t_i16:  op = ops.ConstI16; break
      case t_u32: case t_i32:  op = ops.ConstI32; break
      case t_u64: case t_i64:  op = ops.ConstI64; break
      case t_f32:              op = ops.ConstF32; break
      case t_f64:              op = ops.ConstF64; break
      default:
        assert(false, `invalid constant type ${t}`)
        break
    }

    if (!f.consts) {
      f.consts = new Map<Op,Map<Num,Value>>()
    }

    let nvmap = f.consts.get(op)
    if (!nvmap) {
      nvmap = new Map<Num,Value>()
      f.consts.set(op, nvmap)
    }

    let v = nvmap.get(c)
    if (!v) {
      // create new const value in function's entry block
      v = f.blocks[0].newValue0(op, t, c)
      nvmap.set(c, v) // put into cache
    }

    return v as Value
  }

  constBool(c :bool) :Value {
    return this.constVal(t_bool, c ? 1 : 0)
  }

  removeBlock(b :Block) {
    let i = this.blocks.indexOf(b)
    assert(i != -1, `block ${b} not part of function`)
    this.removeBlockAt(i)
  }

  removeBlockAt(i :int) {
    let b = this.blocks[i]!
    assert(b)
    this.blocks.splice(i, 1)
    this.invalidateCFG()
    this.freeBlock(b)
  }

  // moveBlockToEnd moves block at index i to end of this.blocks
  //
  moveBlockToEnd(i :int) {

    let b = this.blocks[i]! ; assert(b)
    this.blocks.copyWithin(i, i + 1)
    this.blocks[this.blocks.length - 1] = b

    // let endi = this.blocks.length - 1
    // if (i != endi) {
    //   let b = this.blocks[i]! ; assert(b)
    //   this.blocks.copyWithin(i, i + 1)
    //   this.blocks[endi] = b
    // }
  }

  // numBlocks returns an integer larger than the id of any Block in the Fun.
  //
  numBlocks() :int {
    return this.bid
  }

  // numValues returns an integer larger than the id of any Value of any Block
  // in the Fun.
  //
  numValues() :int {
    return this.vid
  }

  postorder() :Block[] {
    if (!this._cachedPostorder) {
      this._cachedPostorder = postorder(this)
    }
    return this._cachedPostorder
  }

  loopnest() :LoopNest {
    return this._cachedLoopnest || (this._cachedLoopnest = loopnest(this))
  }

  // idom returns a map from block id to the immediate dominator of that block.
  // f.entry.id maps to null. Unreachable blocks map to null as well.
  idom() :(Block|null)[] {
    return this._cachedIdom || (this._cachedIdom = dominators(this))
  }

  // sdom returns a tree representing the dominator relationships
  // among the blocks of f.
  sdom() :BlockTree {
    return this._cachedSdom || (this._cachedSdom = new BlockTree(this, this.idom()))
  }

  // invalidateCFG tells the function that its CFG has changed
  //
  invalidateCFG() {
    this._cachedPostorder = null
    this._cachedLoopnest = null
    this._cachedIdom = null
    this._cachedSdom = null
  }

  toString() {
    return this.name.toString()
  }
}


// Pkg represents a package with functions and data
//
export class Pkg {
  // data :Uint8Array   // data  TODO wrap into some simple linear allocator
  funs = new Map<ByteStr,Fun>()   // functions mapped by name
  init :Fun|null = null // init functions (merged into one)

  // mainFun returns the main function of the package, if any
  //
  mainFun() :Fun|null {
    for (let fn of this.funs.values()) {
      if (byteStr_main.equals(fn.name)) {
        return fn
      }
    }
    return null
  }
}


// export const nilFun = new Fun(new FunType([], t_nil), null, 0)
// export const nilBlock = new Block(BlockKind.First, -1, nilFun)
// export const nilValue = new Value(-1, nilBlock, ops.Invalid, t_nil, 0, null)
export const nilValue = new Value(-1, null as any as Block, ops.Invalid, t_nil, 0, null)
