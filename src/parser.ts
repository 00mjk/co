import { Pos, NoPos, SrcFile } from './pos'
import { token, tokstr, prec } from './token'
import * as scanner from './scanner'
import { ErrorHandler, ErrorCode } from './error'
import { TypeResolver } from './resolve'
import { strings, str__ } from './bytestr'
import { Universe } from './universe'
import { DiagHandler, DiagKind } from './diag'
import { SInt64, UInt64 } from './int64'
import { numconv } from './numconv'
import {
  types,
  values,
  t_str0,
  t_void,

  Node,

  File,
  Scope,
  Ent,
  Comment,
  Bad,

  Type,
  PrimType,
  IntType,
  NumType,
  FunType,
  UnresolvedType,
  UnionType,
  ListType,
  TupleType,
  StructType,
  RestType,
  TypeVar,
  AliasType,
  OptionalType,

  Stmt,
  ReturnStmt,
  WhileStmt,
  ForStmt,
  BranchStmt,

  Decl,
  FieldDecl,
  ImportDecl,
  VarDecl,
  TypeDecl,
  MultiDecl,

  Expr,
  Ident,
  FunExpr,
  FunSig,
  NumLit,
  IntLit,
  RuneLit,
  FloatLit,
  StringLit,
  Block,
  IfExpr,
  Assignment,
  Operation,
  CallExpr,
  TupleExpr,
  SelectorExpr,
  IndexExpr,
  SliceExpr,
  ListExpr,
} from './ast'

import { debuglog as dlog } from './util'
// const dlog = function(..._ :any[]){} // silence dlog

const kEmptyByteArray = new Uint8Array(0) // used for empty string

const str_dot  = strings.get(new Uint8Array([0x2e])) // "."
const str_init = strings.get(new Uint8Array([0x69, 0x6e, 0x69, 0x74])) // "init"

const emptyExprList :Expr[] = []

type exprCtx = Type|Assignment|VarDecl|null


export class SyntaxError extends Error {
  pos :Pos

  constructor(msg :string, pos :Pos) {
    super(msg)
    this.name = "SyntaxError"
    this.pos = pos
  }
}

let nextGroupId = 0
class Group {
  id = "group#" + nextGroupId++
  toString() :string { return this.id }
}


// funInfo contains information about the current function, used for data
// that is really only needed during parsing.
class funInfo {
  inferredReturnType :UnionType|null = null // inferred result types

  constructor(
  public f :FunExpr, // the respective function node
  ){}

  addInferredReturnType(t :Type) {
    if (this.inferredReturnType == null) {
      this.inferredReturnType = new UnionType(t.pos, new Set<Type>([t]))
    } else {
      this.inferredReturnType.add(t)
    }
  }
}


// Parser scans source code and produces AST.
// It must be initialized via init before use or resue.
//
export class Parser extends scanner.Scanner {
  fnest      :int = 0   // function nesting level (for error handling)
  universe   :Universe
  comments   :Comment[]|null
  scope      :Scope
  filescope  :Scope
  pkgscope   :Scope
  diagh      :DiagHandler|null = null
  initfnest  :int = 0  // tracks if we're inside an init function
  unresolved :Set<Ident>|null   // unresolved identifiers
  funstack   :funInfo[]  // function stack
  types      :TypeResolver
  throwOnSyntaxError :bool = false  // throw SyntaxError instead of reporting

  initParser(
    sfile      :SrcFile,
    sdata      :Uint8Array,
    universe   :Universe,
    pkgscope   :Scope|null,
    typeres    :TypeResolver,
    errh       :ErrorHandler|null = null,
    diagh      :DiagHandler|null = null,
    smode      :scanner.Mode = scanner.Mode.None,
  ) {
    const p = this
    super.init(sfile, sdata, errh, smode)
    p.scope = new Scope(pkgscope)
    p.filescope = p.scope
    p.pkgscope = pkgscope || p.filescope

    p.fnest = 0
    p.universe = universe
    p.comments = null
    p.diagh = diagh
    p.initfnest = 0
    p.unresolved = null
    p.funstack = []
    p.types = typeres
    p.throwOnSyntaxError = false

    if (smode & scanner.Mode.ScanComments) {
      // sub token reader with one that does does not ignore comments
      p.next = p.next_comments
    }

    p.next()
  }

  next_comments() {
    const p = this
    super.next()
    while (p.tok == token.COMMENT) {
      if (!p.comments) {
        p.comments = []
      }
      p.comments.push(new Comment(p.pos, p.takeByteValue()))
      super.next()
    }
    // TODO: Figure out a way to attach comments to nodes
  }

  got(tok :token) :bool {
    const p = this
    if (p.tok == tok) {
      p.next()
      return true
    }
    return false
  }

  // want reports a syntax error if tok is not p.tok.
  // in any case, this function will advance the scanner by one token.
  //
  want(tok :token) {
    const p = this
    if (!p.got(tok)) {
      p.syntaxError(`expecting ${tokstr(tok)}`)
      p.next()
    }
  }

  // inFun() :FunExpr|null {
  //   return this.funstack[0] || null
  // }

  currFun() :funInfo {
    assert(this.funstack.length > 0, 'access current function at file level')
    return this.funstack[0]
  }

  pushFun(f :FunExpr) {
    this.funstack.push(new funInfo(f))
  }

  popFun() {
    assert(this.funstack.length > 0, 'popFun with empty funstack')
    this.funstack.pop()
  }


  pushScope() {
    const p = this
    p.scope = new Scope(p.scope)
    // dlog(`${(p as any).scope.outer.level()} -> ${p.scope.level()}`)
  }

  popScope() :Scope { // returns old ("popped") scope
    const p = this
    const s = p.scope

    assert(s !== p.filescope, "pop file scope")
    assert(s !== p.pkgscope, "pop file scope")
    assert(p.scope.outer != null, 'pop scope at base scope')

    // dlog(` ${(p as any).scope.outer.level()} <- ${p.scope.level()}`)

    p.scope = p.scope.outer as Scope

    // check for unused declarations
    if (s.decls) for (let [name, ent] of s.decls) {
      if (ent.nreads == 0) {
        if (ent.decl.isFieldDecl()) {
          p.diag("warn", `${name} not used`, ent.decl.pos, (
            ent.decl._scope.context instanceof FunExpr ? 'E_UNUSED_PARAM' :
            'E_UNUSED_FIELD'
          ))
        } else if (!(ent.scope.context instanceof StructType)) {
          p.diag(
            "warn",
            `${name} declared and not used`,
            ent.decl.pos,
            'E_UNUSED_VAR'
          )
        }
      }
    }

    return s
  }

  // declare registers decl and x in scope identified by name
  //
  declare(scope :Scope, ident: Ident, decl :Stmt, x: Expr|null) {
    const p = this

    if (ident.value.isEmpty) {
      // "_" is never declared
      return
    }

    assert(ident.ent == null, `redeclaration of ${ident}`)

    const ent = new Ent(ident.value, decl, x)
    if (!scope.declareEnt(ent)) {
      p.syntaxError(`${ident} redeclared`, ident.pos)
    }

    // dlog(`declare ${ident} => ${decl} in ${scope} [${ent.type}]`)

    ident.ent = ent
    // TODO: in the else branch, we could count locals/registers needed here.
    // For instance, "currFun().local_i32s_needed++"
  }

  // declarev performs multiple declarations at once
  //
  declarev(scope :Scope, idents: Ident[], decl :Stmt, xs: Expr[]|null) {
    const p = this
    for (let i = 0; i < idents.length; ++i) {
      p.declare(scope, idents[i], decl, xs && xs[i] || null)
    }
  }


  resolveEnt(id :Ident) :Ent|null {
    const p = this
    // if (id.value.isEmpty) {
    //   return null  // "_" never resolves
    // }
    assert(id.ent == null, "already resolved")
    let s :Scope|null = id._scope
    while (s) {
      // dlog(`lookupImm ${id} in ${s}`)
      const ent = s.lookupImm(id.value)
      if (ent) {
        // dlog(`${id} found in scope#${s.level()}`)
        id.refEnt(ent)
        return ent
      }
      s = s.outer
    }
    // dlog(`${id} not found`)
    // all local scopes are known, so any unresolved identifier
    // must be found either in the file scope, package scope
    // (perhaps in another file), or universe scope --- collect
    // them so that they can be resolved later
    if (!p.unresolved) {
      p.unresolved = new Set<Ident>([id])
    } else {
      p.unresolved.add(id)
    }
    return null
  }


  // resolveType resolved identifier x as a type.  x is expected to name a type.
  // If the identifier was successfully resolved, x.ent is set to the resolved Ent.
  // x.type is always set to either UndefinedType or a known Type. Returns x.type.
  //
  // Note: This function accepts all types for x which are parsed from dotident
  // for convenience, but actually doesn't support all types named for x.
  resolveType(x :Ident|SelectorExpr|IndexExpr) :Type {
    const p = this
    if (!x.isIdent() || x.value.isEmpty) {
      // TODO: Support SelectorExpr, e.g. "foo.Bar"
      p.syntaxError(`expected type`, x.pos)
      return p.bad<Type>(x.pos, "type")
    }
    let ent = p.resolveEnt(x)
    if (ent) {
      if (!ent.decl.isType()) {
        p.syntaxError(`${x} is not a type`, x.pos)
      } else if (ent.type) {
        x.type = ent.type
        if (x.type.isUnresolvedType()) {
          x.type.addRef(x)
        }
        return x.type
      }
    }
    x.type = p.types.markUnresolved(x)
    return x.type
  }


  // resolveType resolved identifier x as an expression.
  // If the identifier was successfully resolved, x.ent is set to the resolved Ent
  // and x.type is set to either UndefinedType or a known Type.
  resolveVal<T extends Ident|SelectorExpr|IndexExpr>(x :T) :T {
    const p = this
    if (!x.isIdent() || x.value.isEmpty) {
      // TODO: Support SelectorExpr, e.g. "foo.Bar"
      p.syntaxError(`expected identifier`, x.pos)
      return x
    }
    let ent = p.resolveEnt(x)
    if (ent) {
      if (ent.decl.isTypeDecl()) {
        // identifier names a type
        x.type = ent.decl.type
      } else {
        // identifier names a value or is not yet known
        if (!ent.type) {
          x.type = p.types.markUnresolved(x)
          return x  // return to avoid double ref
        }
        x.type = ent.type
      }
      if (x.type.isUnresolvedType()) {
        x.type.addRef(x)
      }
    }
    return x
  }


  // ctxType returns the type of the context, or null if the type is not known
  // or if the type can't be reliably inferred, in which case it should be
  // resolved later on.
  //
  ctxType(ctx :exprCtx) :Type|null {
    const p = this
    if (ctx) {
      if (ctx.isType()) {
        return ctx
      }
      if (ctx.isVarDecl()) {
        return ctx.type
      }
      if (ctx.isAssignment()) {
        // common case: single assignment
        // we handle multi assignments later, in p.assignment()
        return (
          ctx.type ||
          ( ctx.lhs && ctx.lhs.length == 1 ?
              p.types.maybeResolve(ctx.lhs[0]) :
              null
          )
        )
      }
    }
    return null
  }

  parseFile() :File {
    const p = this
    const imports = p.parseImports()
    const decls = p.parseFileBody()

    return new File(
      p.sfile,
      p.scope,
      imports,
      decls,
      p.unresolved,
    )
  }

  parseImports() :ImportDecl[] {
    const p = this
    //
    // Imports     = ImportDecl? | ImportDecl (";" ImportDecl)*
    // ImportDecl  = "import" ( ImportSpec | "(" { ImportSpec ";" } ")" )
    // ImportSpec  = [ "." | PackageName ] ImportPath
    // ImportPath  = string_lit
    //
    let imports = [] as ImportDecl[]
    while (p.got(token.IMPORT)) {
      p.appendGroup(imports, p.importDecl)
      p.want(token.SEMICOLON)
    }
    return imports
  }

  importDecl = (_ :Object|null) :ImportDecl => {
    const p = this
    let localIdent :Ident|null = null
    let hasLocalIdent = false

    switch (p.tok) {
      case token.NAME:
        localIdent = p.ident()
        hasLocalIdent = true
        break

      case token.DOT:
        localIdent = new Ident(p.pos, p.scope, str_dot)
        p.next()
        break
    }

    let path :StringLit
    if (p.tok == token.STRING) {
      path = p.strlit()
    } else {
      p.syntaxError("missing import path; expecting quoted string")
      path = new StringLit(p.pos, kEmptyByteArray, t_str0)
      p.advanceUntil(token.SEMICOLON, token.RPAREN)
    }

    const d = new ImportDecl(p.pos, p.scope, path, localIdent)

    if (hasLocalIdent && localIdent) {
      p.declare(p.filescope, localIdent, d, null)
    }

    return d
  }

  parseFileBody() :Decl[] {
    const p = this
    const decls = [] as Decl[]

    // { TopLevelDecl ";" }
    while (p.tok != token.EOF) {
      switch (p.tok) {

        case token.TYPE:
          p.next() // consume "type"
          p.appendGroup(decls, p.typeDecl)
          break

        case token.NAME:
          const pos = p.pos
          const idents = p.identList(p.ident())
          decls.push(p.varDecl(pos, idents))
          break

        case token.FUN:
          decls.push(p.funExpr(null))
          break

        // TODO: token.TYPE

        default: {
          if (
            p.tok == token.LBRACE &&
            decls.length > 0 &&
            isEmptyFunExpr(decls[decls.length-1])
          ) {
            // opening { of function declaration on next line
            p.syntaxError("unexpected semicolon or newline before {")
          } else {
            p.syntaxError("non-declaration statement outside function body")
          }

          p.error(`TODO file-level token \`${tokstr(p.tok)}\``); p.next()

          p.advanceUntil(/*token.CONST, */token.TYPE, token.FUN)
          continue
        }
      }

      if ((p.tok as token) != token.EOF && !p.got(token.SEMICOLON)) {
        p.syntaxError("after top level declaration")
        p.advanceUntil(/*token.CONST, */token.TYPE, token.FUN)
      }
    }

    return decls
  }

  // checkDeclLen verifies that idents.length == nvalues, and if not,
  // reports a syntax error.
  // Returns true if lengths matches.
  //
  checkDeclLen(lhs :Expr[], nvalues: number, kind :string) :bool {
    const p = this
    if (nvalues != lhs.length) {
      p.syntaxError(
        `cannot assign ${nvalues} values to ${lhs.length} ${kind}`,
        lhs[0].pos
      )
      return false
    }
    return true
  }

  typeDecl = (group :Object|null, _ :int) :TypeDecl => {
    // TypeSpec = "type" identifier [ "=" ] Type
    const p = this
    const pos = p.pos

    // name
    const id = p.ident()

    // // is "X = Y" rather than "X Y"?
    // const isSimpleAlias = p.got(token.ASSIGN)  // type X = Y

    let isAlias = p.tok == token.NAME

    let t = p.maybeType(id)
    if (!t) {
      t = p.bad<Type>(pos, "type")
      p.syntaxError("in type declaration")
      p.advanceUntil(token.SEMICOLON, token.RPAREN)
    }

    // create new alias type, which is basically a Template witout params
    if (isAlias) {
      t = new AliasType(id.pos, id.value, t)
    }

    // scope. ids at the file level are declared in the package scope
    const scope = p.scope === p.filescope ? p.pkgscope : p.scope

    // declare id => t
    p.declare(scope, id, t, null)

    return new TypeDecl(pos, scope, id, t, group)
  }

  varDecl(pos :Pos, idents :Ident[]) :VarDecl|Assignment {
    // VarDecl = IdentifierList
    //           ( Type [ "=" ExpressionList ] | "=" ExpressionList )
    const p = this
    const typ = p.maybeType(null)
    let isError = false

    // ids at the file level are declared in the package scope
    const scope = p.scope === p.filescope ? p.pkgscope : p.scope

    const d = new VarDecl(pos, scope, idents, null, typ, null)

    if (p.got(token.ASSIGN)) {
      // e.g. x, y = 1, 2
      d.values = p.exprList(/*ctx=*/d)
      isError = !p.checkDeclLen(idents, d.values.length, 'constants')
    } else if (!typ) {
      // e.g. `x` -- missing type or values
      p.syntaxError("unexpected identifier", pos)
      isError = true
      d.values = [p.bad()]
      p.advanceUntil(token.SEMICOLON)
    }

    if (isError) {
      return d
    }

    p.processAssign(d.idents, d.values, d, d.type, null)

    return d
  }

  funExpr(ctx :exprCtx) :FunExpr {
    //
    // FunExpr  = "fun" FunName? Signature? FunBody?
    // FunName  = identifier
    // FunBody  = ( Block | "->" Stmt )
    //
    // Note: FunName is required at file level in "fun" declarations
    //
    const p = this
    const pos = p.pos
    p.want(token.FUN)

    const isTopLevel = p.scope === p.filescope

    let name :Ident|null
    let isInitFun = false

    if (isTopLevel && !ctx) {
      // case: statement(!ctx) at top-level
      name = p.ident()
      // functions called "init" at the file level are special
      isInitFun = p.scope === p.filescope && name.value.equals(str_init)
    } else {
      name = p.maybeIdent()
    }

    // scope in which we will declare the function's name.
    // declarations at the top-level are declared in the package scope.
    const scope = isTopLevel ? p.pkgscope : p.scope

    // new scope for parameters, signature and body
    p.pushScope()

    // parse signature.
    //
    // Note: we use the default and special type constant "auto" for all
    // functions but initi functions. This allows us to track multiple return
    // sites and do type checking as we go.
    //
    // Additionally, p.funSig may find an explicit return type in which case
    // it will use that instead. Whenever we encounter a return statement, we
    // will check the expected return type with the actual return type.
    //
    const sig = p.funSig(isInitFun ? t_void : null)

    const f = new FunExpr(pos, p.scope, sig, name, isInitFun)
    p.scope.context = f

    if (isInitFun) {
      // check initfun signature (should be empty)
      if (sig.params.length > 0) {
        p.syntaxError(`init function with parameters`, sig.pos)
      }
      if (sig.result !== t_void) {
        p.syntaxError(`init function with result ${sig.result}`, sig.pos)
      }
    } else {
      // if (sig.result) {
      //   // an explicit result type was provided -- resolve its type
      //   p.types.resolve(sig.result)
      // }

      if (name && !ctx) {
        // The function itself is declared in its outer scope, so that its body
        // can refer to the function, but also so that "funname = x" declares a
        // new variable rather than replacing the function.
        //
        // The check for !ctx is to make sure that decorative names in
        // expressions are not declared in the scope.
        // E.g. the statement "x = fun y(){}" should only declare x in the scope,
        // but not y.
        p.declare(scope, name, f, f)
      }
    }

    // parse body
    if (!isTopLevel || isInitFun || ctx || p.tok != token.SEMICOLON) {

      // Note: the following code can be enabled to disallow type-only param
      // signatures for functions with bodies.
      // e.g. "fun foo(int, f32) {}"
      // if (sig.params.length > 0 && !sig.params[0].name) {
      //   p.syntaxError(
      //     `type-only parameters for function with body`,
      //     sig.pos
      //   )
      // }

      if (isInitFun) { p.initfnest++ }
      p.pushFun(f)

      f.body = p.funBody(name)
      const fi = p.currFun()

      p.popFun()
      if (isInitFun) { p.initfnest-- }

      // pop function body scope before resolving types.
      // otherwise we would run the risk of resolving a type to something
      // that's defined in the function body itself which may shadow outer
      // definitions.
      p.popScope()

      if (f.body instanceof Block) {
        if (!sig.result) {
          // auto result of block = t_void
          //
          // e.g.  fun foo() { ... }
          //   =>  fun foo() void { ... }
          //
          sig.result = t_void
        } else if (!isInitFun && sig.result !== t_void) {
          // convert implicit return to explicit return
          //
          // e.g.  fun foo() i32 { 3 }
          //   =>  fun foo() i32 { return 3 }
          //
          let lastindex = f.body.list.length - 1
          let result = f.body.list[lastindex]
          if (result instanceof Expr) {
            let x = result as Expr
            let xtype = p.types.resolve(x)
            let rettype = sig.result
            if (!(xtype instanceof UnresolvedType) && !xtype.equals(rettype)) {
              // attempt type conversion; rettype -> x.type
              const convexpr = p.types.convertLossless(rettype, x)
              if (convexpr) {
                x = convexpr as Expr
              } else {
                p.syntaxError(
                  x instanceof Ident ?
                    `cannot use ${x} (type ${xtype}) as return type ${rettype}` :
                    `cannot use ${xtype} as return type ${rettype}`,
                  x.pos
                )
              }
            }
            let ret = new ReturnStmt(x.pos, x._scope, x, sig.result)
            f.body.list[lastindex] = ret
          }
        }
      } else if (!sig.result) {
        // expression body with auto result type
        //
        // e.g.  fun foo() -> 3
        //   =>  fun foo() i32 -> 3
        //
        // inferred result type
        if (!fi.inferredReturnType) {
          // no return statements encountered.
          // set result type to same as the body
          sig.result = p.types.resolve(f.body)
        } else if (fi.inferredReturnType.types.size == 1) {
          // single return type (note: may be void if found `return;`)
          sig.result = fi.inferredReturnType.types.values().next().value
        } else {
          // union type
          sig.result = fi.inferredReturnType
        }
      }
    } else {
      if (sig.result === null) {
        // auto
        // for functions without a body and that is missing an explicit
        // result type, void is assumed.
        sig.result = t_void
      }
      p.popScope()
    }

    if (sig.result instanceof UnresolvedType) {
      sig.result.addRef(sig)
    }

    const funtype = p.types.resolve(f) as FunType
    assert(funtype.constructor === FunType) // funtype always resolves

    if (name && !name.value.isEmpty && !isInitFun) {
      // since we declared the name of the function, the name now represents
      // the function and thus its type.
      name.type = funtype
      if (name.ent && !name.ent.type) {
        // assign type to declaration
        name.ent.type = funtype
      }
    }

    return f
  }

  // TODO: maybeFunExpr() :Expr -- FunExpr or some other expr
  // FunExpr = "fun" FunName? Signature FunBody
  // FunName = identifier
  // FunBody  = ( Block | "->" Stmt )

  // funSig parses a function signature
  //
  // Signature = ( Parameters Result? | Type )?
  //
  funSig(result :Type|null): FunSig {
    const p = this
    const pos = p.pos
    const params = p.tok == token.LPAREN ? p.parameters() : []
    if (p.tok != token.LBRACE) {
      result = p.maybeType(null) || result
    }
    return new FunSig(pos, params, result)
  }

  // parameters parses a parameter list
  //
  // This is a pretty complicated function since parameter lists
  // has complex semantics.
  // Three syntax modes are supported:
  //   type, type
  //   OR
  //   ( name type, name type
  //     AND
  //     name, name type )
  //
  // Parameters    = "(" [ ParameterList [ "," ] ] ")"
  // ParameterList = ParameterDecl ("," ParameterDecl)*
  // ParameterDecl = [ NameList ] [ "..." ] Type
  //
  parameters() :FieldDecl[] {
    // examples:
    //
    // (T)
    // (x T)
    // (x, y, z T)
    // (... T)
    // (x  ... T)
    // (x, y, z  ... T)
    // (T1, T2, T3)
    // (T1, T2, ... T3)
    //
    const p = this
    p.want(token.LPAREN)

    let named = 0   // parameters that have an explicit name and type
    let seenRestType = false
    const paramsPos = p.pos
    const fields = [] as FieldDecl[]
    const scope = p.scope

    while (p.tok != token.RPAREN && p.tok != token.EOF) {
      let pos = p.pos

      let typ  :Node|null = null  // used for both names and types, thus Node
      let name :Ident|null = null

      // parse type or name
      if (p.tok == token.NAME) {
        typ = p.dotident(null, p.ident())
      } else {
        // Note: No need to check for ";" or ")" since the "while" condition
        // checks for ")" and an empty parameter set with linebreaks never
        // produces a semicolon implicitly. I.e. "foo(<LF><LF>)" == "foo()"
        // However, it's a syntax error to write "foo(;)"
        let isRest = false
        if (p.tok == token.ELLIPSIS) {
          // ...T
          isRest = true
          p.next()
        }
        let t = p.maybeType(null)
        if (t) {
          typ = isRest ? new RestType(t) : t
        } else {
          typ = p.bad<Type>(p.pos, "type")
          p.syntaxError("expecting name or type", pos)
        }
      }

      if (p.tok != token.COMMA &&
          p.tok != token.SEMICOLON &&
          p.tok as token != token.RPAREN)
      {
        // e.g. func(T), func(... T)

        // move typ -> name as we are about to parse the actual type
        if (typ) {
          // e.g. func(name T)
          if (typ.isIdent()) {
            name = typ
            named++
          } else {
            // e.g. func(a.b.c T)
            p.syntaxError("illegal parameter name", pos)
          }
        }

        // parse type
        if (p.got(token.ELLIPSIS)) {
          // rest
          const x = p.maybeType(null)
          if (x) {
            // let t = p.types.getRestType(p.types.resolve(x)) // before new ast
            typ = new RestType(x)
          } else {
            typ = p.bad<Type>(p.pos, "type")
            p.syntaxError("expecting type after ...")
          }
          if (seenRestType) {
            p.syntaxError("can only use ... with final parameter")
            continue  // error recovery: skip field
          } else {
            seenRestType = true
          }
        } else {
          typ = p.type()
        }
      }

      // parse optional comma, or break on error
      if (!p.ocomma(token.RPAREN)) {
        // error: unexpected SOMETHING, expecting comma, or )
        // e.g. "fun foo(a, b<LF>)" fix -> "fun foo(a, b,<LF>)"
        //                                              ^
        break
      }

      // Note: OK that typ is an Ident here. We may edit this later
      // TODO: cleaner way of doing this
      assert(typ && (typ.isType() || typ.isIdent()))
      fields.push(new FieldDecl(pos, scope, typ as Type, name))
    }

    p.want(token.RPAREN)

    // distribute parameter types
    if (named == 0) {
      // none named -- types only
      for (let f of fields) {
        if (f.type.isIdent()) {
          f.type = p.resolveType(f.type)
        }
      }
    } else {

      if (named < fields.length) {
        // All named, some has types, e.g. func(a, b B, c ...C)
        // some named => all must be named
        let ok = true
        // let typ :Type|null = null
        let t :Type = t_void

        for (let i = fields.length - 1; i >= 0; --i) {
          const f = fields[i]

          if (!f.name) {
            // is a single-name param (name is actually on .type)
            // copy .type -> .name; set .type = typ
            if (f.type.isIdent()) {
              f.name = f.type
              if (t !== t_void) {
                f.type = t
                f.name.type = t
              } else {
                // f.type == t_void && typ == null => we only have a f.name
                ok = false
                f.type = p.bad<Type>(f.type.pos, "type")
              }
            } else {
              p.syntaxError("illegal parameter name", f.type.pos)
            }
          } else if (f.type) {
            // field has name and type

            assert(f.type.isType())
            // if (f.type.isIdent()) {
            //   f.type = p.resolveType(f.type)
            //   f.type = p.types.resolve(f.type)
            // }

            t = f.type

            // if (t.isRestType()) {
            //   // unbox rest type, e.g. "...typ" -> "typ"
            //   const tx = typ.expr
            //   assert(tx.type, 'unresolved type')
            //   typ = new TypeExpr(tx.pos, tx.scope, tx.type as Type)
            // }
            if (f.name) {
              f.name.type = t
            } else {
              ok = false
              f.name = p.fallbackIdent(NoPos)
            }
          }

          if (!ok) {
            p.syntaxError(
              "mixed named and unnamed function parameters",
              paramsPos
            )
            break
          }

          // declare name in function scope
          assert(f.name)
          p.declare(scope, f.name!, f, null)
        }
      } else {
        // All named, all have types
        // declare names in function scope
        for (let f of fields) {
          if (f.type.isIdent()) {
            f.type = p.resolveType(f.type)
          }
          assert(f.name)
          f.name!.type = f.type
          p.declare(scope, f.name!, f, null)
        }
      }
    }

    return fields
  }

  funBody(funcname :Ident|null) :Expr {
    // FunBody = ( Block | "->" Expr )
    const p = this

    if (p.tok == token.LBRACE) {
      // Block
      return p.block()
      // let b = p.block()
      // if (b.list.length > 0) {
      //   let laststmt = b.list[b.list.length-1]
      //   if (laststmt instanceof ReturnExpr) {
      //     // unwrap "return" when it is the last statement in a function, since
      //     // last statement is implicit.
      //     b.list[b.list.length-1] = laststmt.result
      //   }
      // }
      // return b
    }

    if (p.got(token.ARROWR)) {
      // "->" Expr
      return p.expr(/*ctx=*/null)
      // let x = p.expr(/*ctx=*/null)
      // if (x instanceof ReturnExpr) {
      //   // unwrap "return" when it is the last statement in a function, since
      //   // last statement is implicit.
      //   return x.result
      // }
      // return x
    }

    // error
    const pos = p.pos
    if (funcname) {
      p.syntaxError(`${funcname} is missing function body`, pos)
    } else {
      p.syntaxError("missing function body", pos)
    }
    return p.bad(pos)
  }

  blockWithNewScope() :Block {
    const p = this
    p.pushScope()
    const b = p.block()
    p.popScope()
    return b
  }

  // block parses a block expression.
  // The caller manages scope (push/pop if required)
  //
  block() :Block {
    // Block = "{" StatementList "}" | Stmt
    const p = this
    const pos = p.pos
    p.want(token.LBRACE)
    const list = p.stmtList()
    p.want(token.RBRACE)
    return new Block(pos, p.scope, list)
  }

  multiDecl<D extends Decl>(f :(g:Object|null, i:int)=>D) :MultiDecl {
    const p = this
    const pos = p.pos
    p.next() // e.g. TYPE
    const decls :Decl[] = []
    p.appendGroup(decls, f)
    return new MultiDecl(pos, p.scope, decls)
  }

  stmtList() :Stmt[] {
    // StatementList = { Statement ";" }
    const p = this
    const list = [] as Stmt[]

    while (p.tok != token.EOF &&
           p.tok != token.RBRACE &&
           // p.tok != token.CASE &&
           p.tok != token.DEFAULT)
    {
      const s = p.maybeStmt()
      if (!s) {
        break
      }
      list.push(s)
      // customized version of osemi:
      // ';' is optional before a closing ')' or '}'
      if (p.tok == token.RPAREN || p.tok as token == token.RBRACE) {
        continue
      }
      if (!p.got(token.SEMICOLON)) {
        p.syntaxError("at end of statement")
        p.advanceUntil(token.SEMICOLON, token.RBRACE)
      }
    }

    return list
  }

  // shouldStoreToEnt returns true if ent is within atScope in such a way
  // that "ent = value" means "store value to ent".
  //
  shouldStoreToEnt(ent :Ent, atScope :Scope) :bool {
    const p = this
    return (
      ent.scope === atScope  // same scope
      ||
      ( ent.scope !== p.filescope &&
        ( ( ent.scope === p.pkgscope &&
            atScope.context instanceof FunExpr &&
            atScope.context.isInit
          ) ||
          ent.scope.funScope() === atScope.funScope()
        )
      )
    )
  }


  // convertType tries to fit expression x into type t.
  // May return a new conversion expression or x verbatim if x is
  // already compatible with t.
  //
  convertType(t :Type, x :Expr) :Expr {
    const p = this
    if (
      x.type === t ||
      x.type instanceof UnresolvedType ||
      t instanceof UnresolvedType
    ) {
      return x
    }
    const convertedx = p.types.convert(t, x)
    if (convertedx) {
      // if (convertedx !== x) {
      //   // no error and conversion is needed.
      //   // replace original expression with conversion expression
      // }
      return convertedx
    }
    if (!(x.type instanceof UnresolvedType)) {
      p.error(`cannot convert "${x}" (type ${x.type}) to type ${t}`, x.pos)
    }
    return x
  }


  processAssign(
    lhs :Expr[],
    rhs :Expr[]|null,
    decl :VarDecl|Assignment,
    reqt :Type|null,
    decls :bool[]|null,
  ) {
    const p = this

    // Check each left-hand identifier against scope and unresolved.
    // Note that exprList already has called p.resolve on all ids.
    //
    // If an id has an ent (i.e. was resolved to something), then we simply
    // register the assignment with it so that we can later bind.
    //
    // If an id is unresolved (doesn't have an ent), the semantics are:
    // - assume it's a constant definition and declare it as such
    // - register the assignment so that if we later find a var in the outer
    //   scope, we can convert the declaration to an assignment.
    //
    for (let i = 0; i < lhs.length; ++i) {
      const id = lhs[i]

      if (!(id instanceof Ident)) {
        dlog(`TODO LHS is not an id (type is ${id.constructor.name})`)
        continue
      }

      // Decide to store to an existing ent, or declare a new one
      if (decls && rhs && id.ent && p.shouldStoreToEnt(id.ent, id._scope)) {
        // assign to existing ent
        const rval = rhs[i]

        id.incrWrite()

        let typ = id.ent.type
        if (!typ) {
          assert(id.ent.value)
          typ = p.types.resolve(id.ent.value!)
        }

        // const typexpr = id.ent.getTypeExpr()
        // assert(typexpr != null)
        // const typ = p.types.resolve(typexpr as Expr)

        // check & resolve type, converting rval if needed
        id.type = typ

        rhs[i] = p.convertType(typ, rval) // maybeConvRVal(typ, rval, i)

        continue
      }

      id.ent = null

      // new declaration
      //
      // since we are about to redeclare, clear any "unresolved" mark for
      // this identifier expression.
      const rval = rhs ? rhs[i] : null

      if (reqt) {
        id.type = reqt
        if (rval) {
          // see if we need to convert the rval to fit the destination type
          rhs![i] = p.convertType(reqt, rval) // maybeConvRVal(reqt, rval, i)
        }
      } else {
        assert(rval, "processAssign called with no reqt and no rvals")
        id.type = p.types.resolve(rval!)
      }

      if (p.unresolved) { p.unresolved.delete(id) } // may be noop
      // p.declare(id._scope, id, decl, rval)
      p.declare(id._scope, id, decl, null)

      if (id.type.isUnresolvedType()) {
        id.type.addRef(id)
      }

      if (decls && !id.value.isEmpty) {
        decls[i] = true
      }

    } // end for loop
  }


  assignment(lhs :Expr[]) :Expr {
    // Assignment = ExprList "=" ExprList
    const p = this
    p.want(token.ASSIGN) // "="

    const decls = new Array<bool>(lhs.length)
    const s = new Assignment(lhs[0].pos, p.scope, token.ASSIGN, lhs, [], decls)

    // parse right-hand side in context of the function
    s.rhs = p.exprList(/*ctx=*/s)

    if (p.checkDeclLen(lhs, s.rhs.length, 'names')) {
      p.processAssign(s.lhs, s.rhs, s, /*reqt=*/null, decls)
      p.types.resolve(s)
    }

    return s
  }

  // simpleStmt = EmptyStmt | ExpressionStmt | SendStmt | IncDecStmt
  //            | Assignment | VarDecl
  simpleStmt(lhs :Expr[]) :Stmt {
    const p = this

    // Note: token.SET_ASSIGN ":=" is currently unused
    // we could use it to allow shadowing in same scope, e.g.
    //   "b = 4; b := true" where "b :=" redeclares b.

    if (p.tok == token.ASSIGN) {
      // e.g.  "a = 1"  "a, b = 1, 2"  "a[1], b.f = 1, 2"  etc
      return p.assignment(lhs)
    }

    if (p.tok == token.NAME && lhs.every(x => x instanceof Ident)) {
      // var definition
      // e.g. "a T", "a, b, c T" -- declare var with type T

      // first, revert either bindings or unresolved mark of LHS idents
      for (let i = 0; i < lhs.length; i++) {
        let x = lhs[i] as Ident
        if (x.ent) {
          x.unrefEnt()
        } else if (!x.value.isEmpty) {
          assert(p.unresolved != null)
          ;(p.unresolved as Set<Ident>).delete(x)
        }
      }

      // now, form a var declaration (next up may be assignment and values)
      return p.varDecl(lhs[0].pos, lhs as Ident[])
    }

    const pos = lhs[0].pos

    if (lhs.length != 1) {
      p.syntaxError('expecting "=" or ","')
      p.advanceUntil(token.SEMICOLON, token.RBRACE)
      return lhs[0]
    }

    // single expression

    let t = p.types.resolve(lhs[0])

    if (token.assignop_beg < p.tok && p.tok < token.assignop_end) {
      // lhs op= rhs;  e.g. "x += 2"
      let op = p.tok
      p.next() // consume operator

      // map assign ops to regular ops.
      // e.g. "(assign += x 2)" => "(assign + x 2)"
      switch (op) {
        case token.ADD_ASSIGN:     op = token.ADD; break  // +
        case token.SUB_ASSIGN:     op = token.SUB; break  // -
        case token.MUL_ASSIGN:     op = token.MUL; break  // *
        case token.QUO_ASSIGN:     op = token.QUO; break  // /
        case token.REM_ASSIGN:     op = token.REM; break  // %
        case token.AND_ASSIGN:     op = token.AND; break  // &
        case token.OR_ASSIGN:      op = token.OR;  break  // |
        case token.XOR_ASSIGN:     op = token.XOR; break  // ^
        case token.SHL_ASSIGN:     op = token.SHL; break  // <<
        case token.SHR_ASSIGN:     op = token.SHR; break  // >>
        case token.AND_NOT_ASSIGN: op = token.AND_NOT; break // &^
        default:
          assert(false, `unexpected operator token ${token[op]}`)
      }

      // e.g. x += 2
      const s = new Assignment(pos, p.scope, op, lhs, [], [])
      s.rhs = p.exprList(/*ctx=*/s)
      p.types.resolve(s)
      return s
    }

    if (p.tok == token.INC || p.tok == token.DEC) {
      // lhs++ or lhs--
      const op = p.tok
      p.next() // consume operator

      if (!(t instanceof IntType) && !(t instanceof UnresolvedType)) {
        // lhs is not a mutable type. For instance, it might be str.
        this.syntaxError(`cannot mutate ${lhs[0]} of type ${t}`, lhs[0].pos)
      }

      let s = new Assignment(pos, p.scope, op, lhs, emptyExprList, [])
      p.types.resolve(s)
      return s
    }

    if (p.tok == token.ARROWL) {
      // lhs <- rhs
      p.syntaxError("TODO simpleStmt ARROWL")
    }

    if (p.tok == token.ARROWR) {
      // params -> result
      p.syntaxError("TODO simpleStmt ARROWR")
    }

    // else: expr
    return lhs[0]
  }


  maybeStmt() :Stmt|null {
    // Statement =
    //   Declaration | LabeledStmt | simpleStmt |
    //   GoStmt | ReturnStmt | BreakStmt | ContinueStmt | GotoStmt |
    //   FallthroughStmt | Block | IfExpr | SwitchStmt | SelectStmt | ForStmt |
    //   DeferStmt .
    const p = this

    switch (p.tok) {
      // Most statements (assignments) start with an identifier;
      // look for it first before doing anything more expensive.
      case token.NAME:
      case token.NAMEAT:
        return p.simpleStmt(p.exprList(/*ctx=*/null))

      case token.LBRACE:
        return p.blockWithNewScope()

      case token.TYPE:
        return p.multiDecl(p.typeDecl)

      case token.ADD:
      case token.SUB:
      case token.MUL:
      case token.AND:
      case token.NOT:
      case token.XOR: // unary operators
      case token.FUN:
      case token.LPAREN: // operands
      case token.LBRACKET:
      // case token.STRUCT:
      // case token.CHAN:
      case token.INTERFACE: // composite types
      // case token.ARROW: // receive operator
        return p.simpleStmt(p.exprList(/*ctx=*/null))

      case token.FOR:
        return p.forStmt()

      // case token.SWITCH:
      //   return p.switchStmt()

      // case token.SELECT:
      //   return p.selectStmt()

      case token.WHILE:
        return p.whileStmt()

      case token.IF:
        return p.ifExpr(/*ctx=*/null)

      // case token.FALLTHROUGH:
      //   s := new(BranchStmt)
      //   s.pos = p.pos()
      //   p.next()
      //   s.Tok = _Fallthrough
      //   return s

      case token.BREAK:
      case token.CONTINUE:
        return p.branchStmt()

      // case token.GO, token.DEFER:
      //   return p.callStmt()

      // case token.GOTO:
      //   s := new(BranchStmt)
      //   s.pos = p.pos()
      //   s.Tok = _Goto
      //   p.next()
      //   s.Label = p.name()
      //   return s

      case token.RETURN:
        return p.returnStmt()

      // case token.SEMI:
      //   s := new(EmptyStmt)
      //   s.pos = p.pos()
      //   return s

      default:
        if (token.literal_beg < p.tok && p.tok < token.literal_end) {
          return p.simpleStmt(p.exprList(/*ctx=*/null))
        }
    }

    return null
  }

  branchStmt() :BranchStmt {
    const p = this
    let s = new BranchStmt(p.pos, p.scope, p.tok)
    p.next()
    if (p.tok == token.NAME) {
      s.label = p.resolveVal(p.ident())
    }
    return s
  }

  // WhileStmt = "while" Expression? Block
  //
  whileStmt() :WhileStmt {
    const p = this
    const pos = p.pos

    p.want(token.WHILE)
    p.pushScope()

    let cond :Expr|null = null
    if (p.tok != token.LBRACE) {
      cond = p.expr(types.bool)
      p.types.resolve(cond)
    }

    const body = p.block()

    p.popScope()

    return new WhileStmt(pos, p.scope, cond, body)
  }

  // "for" init ; cond ; incr { body }
  forStmt() :ForStmt {
    const p = this
    const pos = p.pos

    p.want(token.FOR)
    p.pushScope()

    let init = p.maybeStmt()
    p.want(token.SEMICOLON)

    let cond :Expr|null = null
    if (p.tok != token.SEMICOLON) {
      cond = p.expr(types.bool)
      p.types.resolve(cond)
    }
    p.want(token.SEMICOLON)

    let incr :Stmt|null = null
    if (p.tok != token.LBRACE) {
      incr = p.maybeStmt()
      if (!incr) {
        p.syntaxError("expecting statement or block")
        p.next()
      }
    }

    const body = p.block()

    p.popScope()

    print(`for ${init}; ${cond}; ${incr}`)

    return new ForStmt(pos, p.scope, init, cond, incr, body)
  }

  ifExpr(ctx :exprCtx) :IfExpr {
    //
    // IfExpr = "if" Expression Block
    //          [ "else" ( IfExpr | Block ) ]
    //
    // e.g. `if x > 1 "large" else "small"`
    // e.g. `if x = size() > 1 print("large number: $x")`
    //
    const p = this

    // push a scope for conditions to support e.g. capture of x in
    //   if x = a() > 0 print("$x > 0") else print("$x < 0")
    //
    p.pushScope()
    const s = p.ifExpr2(ctx)
    p.popScope()

    return s
  }

  ifExpr2(ctx :exprCtx) :IfExpr {
    // used by ifExpr
    const p = this
    const pos = p.pos
    const scope = p.scope

    p.want(token.IF)

    const cond = p.expr(ctx)
    p.types.resolve(cond)

    const then = p.expr(ctx)

    const s = new IfExpr(pos, scope, cond, then, null)

    if (p.got(token.ELSE)) {
      if (p.tok == token.IF) {
        s.els_ = p.ifExpr2(ctx)
      } else {
        p.pushScope()
        s.els_ = p.expr(ctx)
        p.popScope()
      }
    }

    return s
  }

  returnStmt() :ReturnStmt {
    const p = this
    const pos = p.pos

    p.want(token.RETURN)

    // expected return type (may be null (auto); VoidType for init)
    const fi = p.currFun()
    const frtype = fi.f.sig.result

    assert(!frtype || frtype.isUnresolved(), "currFun sig.result type not resolved")

    const n = new ReturnStmt(pos, p.scope, values.nil, t_void)

    if (p.tok == token.SEMICOLON || p.tok == token.RBRACE) {
      // no result; just "return"
      if (frtype !== t_void) {
        if (frtype === null && fi.inferredReturnType == null) {
          // patch current function's signature: void result type
          fi.f.sig.result = t_void
        } else {
          // if `fi.inferredReturnType != null` that means the block returns
          // both some type and nothing, which is invalid.
          p.syntaxError(
            `missing return value; expecting ${fi.inferredReturnType || frtype}`
          )
        }
      }
      return n
    }

    // expecting one or more results to follow "return"

    const xs = p.exprList(/*ctx=*/null) // ?: maybe pass TupleExpr as ctx?

    let rval = (
      xs.length == 1 ? xs[0] :
        // e.g. "return 1", "return (1, 2)"

      new TupleExpr(xs[0].pos, xs[0]._scope, xs)
        // Support paren-less tuple return
        // e.g. "return 1, 2" == "return (1, 2)"
    )

    if (frtype === t_void) {
      p.syntaxError("function does not return a value", rval.pos)
      return n
    }

    const rtype = p.types.resolve(rval)
    n.result = rval
    n.type = rtype

    if (frtype === null) {
      // return type is auto -- register inferred result type
      fi.addInferredReturnType(rtype)

    } else {
      assert(frtype)
      if (
        !rtype.isUnresolvedType() && // type is known, and
        !rtype.equals(frtype!) // type is different than function's ret type
      ) {
        // attempt type conversion; rtype -> frtype.type
        const convexpr = p.types.convert(frtype!, rval)
        if (convexpr) {
          n.result = convexpr
          n.type = frtype!
        } else {
          // error: type mismatch
          p.syntaxError(
            (rval.type && rval.type.isUnresolvedType() ?
              `cannot use "${rval}" as return type ${frtype}` :
              `cannot use "${rval}" (type ${rval.type}) as return type ${frtype}`
            ),
            rval.pos
          )
        }
      }
    }

    return n
  }

  exprList(ctx :exprCtx) :Expr[] {
    // ExpressionList = Expression ( "," Expression )*
    const p = this
    const list = [p.expr(ctx)]
    while (p.got(token.COMMA)) {
      list.push(p.expr(ctx))
    }
    return list
  }

  expr(ctx :exprCtx) :Expr {
    const p = this
    return p.binaryExpr(prec.LOWEST, ctx)
  }

  binaryExpr(pr :prec, ctx :exprCtx) :Expr {
    // Expression = UnaryExpr | Expression binary_op Expression
    const p = this
    let x = p.unaryExpr(pr, ctx)

    // if (ctx && !ctx.type && ctx instanceof Assignment) {
    //   let ctxt = p.ctxType(ctx)
    //   if (!ctxt) {
    //     // in assignment context without type, assume type of first value
    //     ctx.type = p.types.resolve(x)
    //   }
    // }

    return p.maybeBinaryExpr(x, pr, ctx)
  }


  // Call after parsing an expression which might be part of a binary expression.
  // If the next token is a binary-expression operator, then return an Operator,
  // otherwise x is returned verbatim.
  //
  maybeBinaryExpr(x :Expr, pr :prec, ctx :exprCtx) :Expr {
    const p = this
    while (token.operator_beg < p.tok && p.tok < token.operator_end && p.prec > pr) {
      // save operator info and parse next token
      const pos = p.pos
      const pr2 = p.prec
      const op = p.tok
      p.next()

      // expect some expression to follow
      let y = p.binaryExpr(pr2, ctx)
      x = new Operation(pos, p.scope, op, x, y)

      // Note: We need to resolve types here rather than outside this
      // loop since x may be an identifier in the left-hand-side of an
      // assignment operation, which would cause type resolution to fail,
      // which is slow.
      p.types.resolve(x)
    }
    return x
  }


  // maybeGenericTypeInstance parses either a "less than" binop, e.g. "x<y",
  // or a generic type instance expression, e.g. "type<arg>".
  //
  // LtBinOp         = Expr "<" Expr
  // GenericTypeExpr = TypeExpr "<" ExprList ","? ">"
  //
  maybeGenericTypeInstance(lhs :Expr, pr :prec, ctx :exprCtx) :Expr {
    const p = this
    assert(p.tok == token.LSS)  // enter at token.LSS "<"

    // // TODO: re-introduce generics/templates
    return p.maybeBinaryExpr(lhs, pr, ctx)
    // return p.tryWithBacktracking(

    //   // try to parse as generic type, e.g. "x<y>"
    //   () => {
    //     let t = p.types.resolve(lhs)
    //     return p.genericType(t)
    //   },

    //   // else, parse as binary expression, e.g. "x < y"
    //   () => p.maybeBinaryExpr(lhs, pr, ctx),
    // )
  }


  unaryExpr(pr :prec, ctx :exprCtx) :Expr {
    // UnaryExpr = PrimaryExpr | unary_op UnaryExpr
    const p = this
    const t = p.tok
    const pos = p.pos

    switch (t) {
      case token.ADD:
      case token.SUB:
      case token.NOT:
      case token.XOR: {
        p.next()
        // unaryExpr may have returned a parenthesized composite literal
        // (see comment in operand)
        let x = new Operation(pos, p.scope, t, p.unaryExpr(pr, ctx), null)
        p.types.resolve(x)

        let isint = x.type instanceof IntType
        if (!isint && t != token.ADD && t != token.SUB) {
          p.syntaxError(
            `invalid operation ${tokstr(t)} ${p.types.resolve(x.x)}`
          )
        }

        return x
        // legacy: unparen(p.unaryExpr(ctx)) to unwrap ParenExpr.
      }

      // TODO: case token.ARROWL; `<-x`, `<-chan E`
    }

    return p.primExpr(pr, ctx)
  }


  primExpr(pr :prec, ctx :exprCtx) :Expr {
    // PrimaryExpr =
    //   Operand |
    //   Conversion |
    //   PrimaryExpr Selector |
    //   PrimaryExpr Index |
    //   PrimaryExpr Slice |
    //   PrimaryExpr TypeAssertion |
    //   PrimaryExpr Arguments .
    //
    // Selector       = "." identifier .
    // Index          = "[" Expression "]" .
    // Slice          = "[" ( [ Expression ] ":" [ Expression ] ) |
    //                      ( [ Expression ] ":" Expression ":" Expression )
    //                  "]" .
    // TypeAssertion  = "." "(" Type ")" .
    // Arguments      = "("
    //   [ (  ExpressionList | Type [ "," ExpressionList ] ) [ "..." ] [ "," ]]
    //   ")" .
    let p = this
    let x = p.operand(ctx)

    loop:
    while (true) switch (p.tok) {

      case token.LPAREN:
        x = p.call(x, ctx)
        break  // may be more calls, e.g. foo()()()

      case token.LBRACKET:
        x = p.bracketExpr(x, ctx)
        break

      case token.DOT:
        x = p.selectorExpr(x, ctx)
        break

      case token.LSS:
        // could be either x<y (LT x y) or x<y> (type x y)
        x = p.maybeGenericTypeInstance(x, pr, ctx)
        break

      default:
        break loop
    }

    return x
  }


  // TODO: callPrimType(fun :Expr, t :PrimType) :CallExpr {
  // }


  call(receiver :Expr, _ :exprCtx) :CallExpr {
    // Arguments = "(" [
    //     ( ExpressionList | Type [ "," ExpressionList ] )
    //     [ "..." ] [ "," ]
    //   ] ")"
    const p = this

    // expected arguments from potentially known function type
    let argtypes :Type[] = []

    // do we know the function type?
    if (receiver.isType()) {
      dlog(`calling a type ${receiver.type} (via receiver.isType)`)
      if (receiver.isPrimType()) {
        // TODO: fast path for common case: conversion to primitive type
        // return p.callPrimType(receiver, receiver.type.type)
      }
      argtypes = [ receiver ]
    } else if (receiver.type instanceof FunType) {
      argtypes = receiver.type.args
    } else { // unresolved
      assert(
        receiver.type == null,
        `resolved, unexpected receiver=${receiver} .type=${receiver.type} ` +
        `(${receiver.type && receiver.type.constructor.name})`
      )
    }

    // call or conversion
    // convtype '(' expr ocomma ')'
    const pos = p.pos
    const args = [] as Expr[]
    let hasDots = false

    p.want(token.LPAREN)

    if (receiver.type && !receiver.type.isUnresolved()) {
      // parse expected arguments with type information
      let i = 0  // index into argtypes
      let restType :Type|null = null  // set when we encounter ...
      while (p.tok != token.EOF && p.tok != token.RPAREN) {
        // parse arg with expected argtype as context
        let argtype :Type|null = restType
        if (!argtype) {
          argtype = argtypes[i++] || null
          if (argtype instanceof RestType) {
            restType = argtype
          }
        }
        // parse arg with context set to the expected argument type
        args.push(p.expr(argtype))
        hasDots = p.got(token.ELLIPSIS)
        if (!p.ocomma(token.RPAREN) || hasDots) {
          break
        }
      }
      // Note: Actual verification and conversion of argument types is done
      // by the resolver.
    } else {
      // The function type is unknown.
      // Parse any arguments until we encounter a closing ")"
      while (p.tok != token.EOF && p.tok != token.RPAREN) {
        args.push(p.expr(null))
        hasDots = p.got(token.ELLIPSIS)
        if (!p.ocomma(token.RPAREN) || hasDots) {
          break
        }
      }
    }

    p.want(token.RPAREN)

    return new CallExpr(pos, p.scope, receiver, args, hasDots)
  }


  operand(ctx :exprCtx) :Expr {
    // Operand   = Literal | OperandName | MethodExpr | "(" Expression ")" .
    // Literal   = NumLit | string_lit | CompositeLit | FunctionLit .
    // NumLit    = int_lit | float_lit
    // OperandName = identifier | QualifiedIdent.
    const p = this

    switch (p.tok) {
      case token.NAME:
      case token.NAMEAT:
        return p.dotident(ctx, p.resolveVal(p.ident()))

      case token.LPAREN:
        return p.parenExpr(ctx)

      case token.FUN:
        return p.funExpr(ctx)

      case token.LBRACE:
        return p.blockWithNewScope()

      case token.IF:
        return p.ifExpr(ctx)

      // case _Lbrack, _Chan, _Map, _Struct, _Interface:
      //   return p.type_() // othertype

      case token.LBRACKET:
        return p.listExpr(ctx)

      case token.STRING:
        return p.strlit()

      case token.INT:
      case token.INT_BIN:
      case token.INT_OCT:
      case token.INT_HEX:
        return p.intLit(ctx, p.tok)

      case token.CHAR:
        return p.runeLit(ctx)

      case token.FLOAT:
        return p.floatLit(ctx)

      default: {
        const x = p.bad()
        p.syntaxError("expecting expression")
        return x
      }
    }
  }


  runeLit(ctx :exprCtx) :NumLit {
    const p = this
    assert(p.int32val >= 0, 'negative character value')
    const x = new RuneLit(p.pos, p.int32val)
    p.next() // consume literal token
    return p.convNum(x, p.ctxType(ctx))
  }


  floatLit(ctx :exprCtx) :NumLit {
    const p = this
    assert(!isNaN(p.floatval), 'scanner produced invalid number')
    const x = new FloatLit(p.pos, p.floatval, types.f64)
    p.next() // consume literal token
    let dstt = p.ctxType(ctx)
    if (dstt) {
      if (dstt === types.f32) {
        // common case: context is f32 and we parsed a float literal.
        // attempt to fit the literal into f32.
        let [, lossless] = numconv(x.value, types.f32)
        if (lossless) {
          x.type = types.f32
        } else {
          p.syntaxError(`constant ${x} overflows ${types.f32}`, x.pos)
        }
      } else if (dstt !== x.type) {
        return p.convNum(x, dstt)
      }
    }
    return x
  }


  intLit(
    ctx :exprCtx,
    tok :token.INT | token.INT_BIN | token.INT_OCT | token.INT_HEX,
  ) :NumLit {
    const p = this
    let x :IntLit

    // prefer signed integer types when the value fits
    if (p.int64val) {
      if (p.int64val.isSigned || p.int64val.lte(SInt64.MAX)) {
        x = new IntLit(p.pos, p.int64val.toSigned(), types.i64, tok)
      } else {
        assert(p.int64val instanceof UInt64)
        x = new IntLit(p.pos, p.int64val, types.u64, tok)
      }
    } else {
      const t = p.int32val <= 0x7fffffff ? types.int : types.uint
      x = new IntLit(p.pos, p.int32val, t, tok)
    }

    p.next() // consume literal token

    // return possibly-converted number literal
    return p.convNum(x, p.ctxType(ctx))
  }


  // convNum may convert x (in-place) to a different type as requested by reqt.
  //
  convNum(x :NumLit, reqt :Type|null) :NumLit {
    if (!reqt || reqt === types.bool) {
      return x
    }
    const p = this
    // unwrap rest type. e.g. ...u32 => u32
    if (reqt.isRestType()) {
      reqt = reqt.type
    }
    if (reqt.isNumType()) {
      // capture refs to current type and value before converting, as
      // convertToType may change these properties.
      let xv = x.value
      let xt = x.type
      if (!x.convertToType(reqt)) {
        if ((xt instanceof IntType) == (reqt instanceof IntType)) {
          p.syntaxError(`constant ${xv} overflows ${reqt.name}`, x.pos)
        } else {
          p.syntaxError(`constant ${xv} (type ${xt}) truncated to ${reqt.name}`, x.pos)
        }
      }
    } else {
      // reqt is not a number type
      p.syntaxError(`invalid value ${x.value} for type ${reqt}`, x.pos)
    }
    return x
  }


  numLitErrH = (msg :string, pos :Pos) => {
    this.syntaxError(msg, pos)
  }


  strlit() :StringLit {
    const p = this
    assert(p.tok == token.STRING)
    const bytes = p.takeByteValue()
    let n :StringLit
    if (bytes.length == 0) {
      // str<0> ""
      n = new StringLit(p.pos, kEmptyByteArray, t_str0)
    } else {
      n = new StringLit(p.pos, bytes, p.types.getStrType(bytes.length))
    }
    p.next()
    return n
  }


  // SelectorExpr = Expr "." ( Ident | IntLit )
  //
  selectorExpr(operand :Expr, ctx :exprCtx) :SelectorExpr|IndexExpr {
    const p = this
    p.want(token.DOT)
    const pos = p.pos  // pos is after "."

    let rhs :Expr

    switch (p.tok) {

    case token.NAME:
      // e.g. "a.b"
      rhs = p.dotident(ctx, p.ident())
      break

    case token.INT:
    case token.INT_BIN:
    case token.INT_OCT:
    case token.INT_HEX:
      // e.g. "t.3"
      let x = new IndexExpr(pos, p.scope, operand, p.intLit(ctx, p.tok))
      let optype = operand.type ? operand.type.canonicalType() : null
      if (optype instanceof TupleType) {
        if (!p.types.maybeResolveTupleAccess(x)) {
          x.type = p.types.markUnresolved(x)
        }
      } else {
        // numeric access on something that's not a tuple
        x.type = p.types.markUnresolved(x)
        p.syntaxError(
          `numeric field access on non-tuple type ${optype}`,
          pos
        )
      }
      return x

    default:
      p.syntaxError('expecting name or integer after "."')
      rhs = p.bad(pos)
      break
    }

    return new SelectorExpr(pos, p.scope, operand, rhs)
  }


  // dotident = Ident | SelectorExpr
  //
  dotident(ctx :exprCtx, ident :Ident) :Ident|SelectorExpr|IndexExpr {
    const p = this
    return p.tok == token.DOT ? p.selectorExpr(ident, ctx) : ident
  }


  // ListExpr = "[" ExprList [("," | ";")] "]"
  //
  listExpr(ctx :exprCtx) :ListExpr {
    const p = this
    const pos = p.pos
    p.want(token.LBRACKET)

    let l :Expr[] = []
    let ctxt = p.ctxType(ctx)
    let t :ListType|null = ctxt instanceof ListType ? ctxt : null
    let itemtype :Type|null = t ? t.type : null

    while (p.tok != token.RBRACKET && p.tok != token.EOF) {
      let x = p.expr(itemtype)
      if (!t) {
        if (x.type && !x.type.isUnresolved()) {
          t = new ListType(x.type)
        }
      } else {
        x = p.types.convert(t.type, x) || x
      }
      l.push(x)
      if (
        !p.got(token.SEMICOLON) &&
        p.tok as token != token.RBRACKET &&
        !p.ocomma(token.RBRACKET)
      ) {
        break  // error: unexpected ;, expecting comma, or )
      }
    }
    p.want(token.RBRACKET)

    if (l.length == 0 && !t) {
      p.syntaxError(`unable to infer type of empty list`, pos)
    }

    return new ListExpr(pos, p.scope, l, t)
  }


  typedListExpr(operand :Type) :ListExpr {
    return this.listExpr(operand)
  }


  // bracketExpr = ListExpr | TypeExpr | IndexExpr | SliceExpr
  // IndexExpr   = Expr "[" Expr "]"
  // SliceExpr   = Expr "[" Expr? ":" Expr? "]"
  //
  bracketExpr(operand :Expr, ctx :exprCtx) :Expr {
    const p = this

    if (operand.isType()) {
      // operand is type, e.g. int[][...
      //                       ~~~~~
      return p.typedListExpr(operand)
    }

    // Note on case where operand isType
    //
    // operand is type, e.g. int[...
    //                       ~~~
    // This syntax is a little tricky as it only works when the type has been
    // resolved already.
    // It means that the following cases are different:
    //
    // Case 1:
    //   type foo int
    //   a = foo[1, 2]  // ok as foo's type is resolved here
    //
    // Case 2:
    //   a = foo[1, 2]  // error, as foo's type is unknown here
    //   type foo int
    //
    // We could work around this by looking for commas when parsing the
    // brackets, but single-item expressions would become ambiguous. e.g.
    //
    //   int[2, 3] would be parsed as ListExpr
    //   int[2]    would be parsed as IndexExpr !
    //   int[2,]   would be parsed as ListExpr
    //   int[][2]  would be parsed as ListExpr
    //
    // So, it would be a very small benefit (not having to add "[]" at end of
    // list type expr) but introduce unintuitive syntax, which isn't worth it.

    const pos = p.pos
    p.want(token.LBRACKET)

    if (p.got(token.RBRACKET)) {
      // list type expression. e.g. x[]
      dlog(`TODO: FIXUP generics`)
      // let opt :Type = p.types.resolve(operand).canonicalType()
      // let lt = p.types.getGenericInstance(t_list, [opt])
      // return new TypeExpr(pos, p.scope, lt)
    }

    let x1 :Expr|null = null
    if (p.tok != token.COLON) {
      x1 = p.expr(ctx)
    }

    if (p.got(token.COLON)) {
      // slice, e.g. "x[1:3]", "x[:3]", "x[1:]", "x[:]"
      let endx :Expr|null = null

      if (!p.got(token.RBRACKET)) {
        // explicit end, e.g. "x[1:3]", "x[:3]
        endx = p.expr(ctx)
        p.want(token.RBRACKET)
      } // else: implicit end, e.g. "x[1:]", "x[:]"

      let x = new SliceExpr(pos, p.scope, operand, x1, endx)

      if (operand.type instanceof TupleType) {
        // non-uniform operand type
        // we need to resolve indexes to find type
        if (!p.types.tupleSlice(x)) {
          x.type = p.types.markUnresolved(x) as any as TupleType  // FIXME
        }
      } else dlog(`TODO handle uniform slice operand ${operand.type}`)

      return x
    }

    // index
    if (!p.got(token.RBRACKET)) {
      p.syntaxError(`in index expression; expecting ]`)
      if (p.tok == token.COMMA) {
        // common mistake: int[1,2] -- really want int[][1,2]
        p.diag("info", `Did you mean ${operand}[] here?`, pos, "E_SUGGESTION")
      }
      p.advanceUntil(token.RBRACKET) // avoids superfluous errors in common cases
      p.next()
      return p.bad<Expr>(pos)
    }

    assert(x1)
    assert(x1!.isExpr())

    let x = new IndexExpr(pos, p.scope, operand, x1!)

    if (operand.type instanceof TupleType) {
      // non-uniform operand type
      // we need to resolve index to find type
      if (!p.types.maybeResolveTupleAccess(x)) {
        x.type = p.types.markUnresolved(x)
      }
      return x
    }

    // else: operand is unitype or unknown
    dlog(`TODO resolve item type for uniform operand of type ${operand.type}`)
    x.type = p.types.markUnresolved(x)
    return x
    // return p.types.resolveIndex(x)
  }


  // ParenExpr = "(" Expr ","? ")" | TupleExpr | Assignment
  // TupleExpr = "(" Expr ("," Expr)+ ","? ")"
  //
  parenExpr(ctx :exprCtx) :Expr {
    const p = this
    const pos = p.pos
    p.want(token.LPAREN)

    const l :Expr[] = []
    while (true) {
      l.push(p.expr(ctx))
      if (p.tok == token.ASSIGN) {
        // e.g. "(a, b = 1, 2)"
        const x = p.assignment(l)
        p.want(token.RPAREN)
        return x
      }
      if (!p.ocomma(token.RPAREN)) {
        break  // error: unexpected ;, expecting comma, or )
      }
      if (p.tok == token.RPAREN) {
        break
      }
    }
    p.want(token.RPAREN)

    return (
      // l.length == 1 ? (
      //   p.keepParens ? new ParenExpr(pos, p.scope, l[0]) :
      //   l[0]
      // ) :
      l.length == 1 ? l[0] :
      new TupleExpr(pos, p.scope, l)
    )
  }


  bad<T extends Node = Expr>(pos? :Pos, message :string = "") :T {
    const p = this
    return new Bad(pos === undefined ? p.pos : pos, message) as any as T
  }


  // type parses a type
  //
  type() :Type {
    const p = this
    let t = p.maybeType(null)
    if (!t) {
      t = p.bad<Type>(p.pos, "type")
      p.syntaxError("expecting type")
      p.next()
    }
    return t
  }


  // maybeType parses a type.
  // Returns null if there was no type.
  //
  // If you expect a type, use type() instead which repors an error if no
  // type is found.
  //
  // Type     = TypeName | TypeLit | "(" Type ")" .
  // TypeName = identifier | QualifiedIdent .
  // TypeLit  = ArrayType | StructType | PointerType | FunctionType
  //          | InterfaceType | SliceType | MapType | Channel_Type
  //
  maybeType(name :Ident|null) :Type|null {
    const p = this
    let t :Type|null = null

    switch (p.tok) {

      case token.NAME: {
        // TODO: resolveType on dotident, not leaf ident
        let x = p.dotident(null, p.ident())
        p.resolveType(x)
        t = p.types.resolve(x)
        // TODO: re-introduce generics/templates
        //
        // Here, we want to check t and make sure it's a TemplateType,
        // then we'll try to resolve its free type variables with the
        // provided ones (e.g. A and B in Foo<A,B>).
        //
        // It's possible that we will not be able to bind all variables,
        // which is probably fine and we would in that case produce
        // another TemplateType with a scope with the provided bindings.
        //
        // Idea: Track Template parse scope in Scope. That way we could
        // check right here if Foo<A,B> is an expansion of a template or not.
        //
        // This because we could be inside a template already, e.g.
        //   type Bar<T> List<T>
        //   type Foo<A,B> {
        //     x Bar<A>  // <-  Bar<A> is a template over Bar<T> with binding A=T
        //   }
        //
        break
      }

      case token.LPAREN:
        t = p.tupleType()
        break

      case token.LBRACE:
        t = p.structType(name)
        break

    }

    if (t) {
      // optional, e.g. "x Foo?"
      if (p.got(token.QUESTION)) {
        let t1 = t
        t = new OptionalType(t.pos, t1)
        if (t1.isUnresolvedType()) {
          t1.addRef(t)
        }
      }
      // list. e.g. Foo[][]
      while(p.tok == token.LBRACKET) {
        t = p.listType(t)
      }
      // Note: Optional list is invalid since empty list==nil.
      // i.e. x Foo[]? is a syntax error
    }

    return t
  }


  // ListType = Type "[]"
  listType(t :Type) :ListType {
    const p = this
    p.want(token.LBRACKET)
    p.want(token.RBRACKET)
    return new ListType(t)
  }


  // TupleType = "(" Type ("," Type)+ ","? ")"
  // Returns null for empty tuples, i.e. "()"
  // Returns the inner type for single-type tuples, i.e. "(Type)"
  //
  tupleType() :Type|null {
    const p = this
    p.want(token.LPAREN)
    const pos = p.pos
    let t :Type|null = null
    const types = [] as Type[]

    while (p.tok != token.RPAREN && p.tok != token.EOF) {
      t = p.type()
      types.push(t)
      if (!p.ocomma(token.RPAREN)) {
        // error: unexpected ;, expecting comma, or )
        break
      }
    }
    p.want(token.RPAREN)

    if (!t) {
      return null  // "()"  => null
    }

    if (types.length == 1) {
      return t  // "(a)" => "a"
    }

    return p.types.getTupleType(types)
  }


  // StructType     = "{" (Field ";")* "}"
  // Field          = (VarDecl | EmbeddedField | MethodDecl)
  // EmbeddedField  = TypeName
  //
  structType(name :Ident|null) :StructType|null {
    const p = this
    const pos = p.pos
    const decls :Decl[] = []

    p.want(token.LBRACE)  // {

    // struct has its own scope
    p.pushScope()
    let st = new StructType(pos, name, decls)
    p.scope.context = st

    // { TopLevelDecl ";" }
    while (p.tok != token.RBRACE && p.tok != token.EOF) {
      switch (p.tok) {

        case token.TYPE:
          p.next() // consume "type"
          p.appendGroup(decls, p.typeDecl)
          break

        case token.NAME:
          const pos = p.pos
          const idents = p.identList(p.ident())
          decls.push(p.varDecl(pos, idents))
          break

        case token.FUN:
          decls.push(p.funExpr(null))
          break

        default:
          p.syntaxError("expected declaration")
          p.advanceUntil(token.RBRACE)
          break
      }

      if ((p.tok as token) != token.RBRACE && !p.got(token.SEMICOLON)) {
        p.syntaxError("in struct declaration")
        p.advanceUntil(token.RBRACE)
      }
    }

    p.popScope()
    p.want(token.RBRACE)  // }

    return st
  }


  // // GenericTypeInstance = Type "<" (TypeArgs ","? )? ">"
  // // TypeArgs            = Type ("," Type)*
  // //
  // genericType(t :Type) :Type {
  //   const p = this
  //   const pos = p.pos
  //   const args :Type[] = []

  //   p.want(token.LSS)  // consume "<"

  //   if (!t.isGenericType()) {
  //     p.syntaxError(`unexpected type vars for non-generic type ${t}`, pos)
  //     return t
  //   }

  //   while (p.tok != token.GTR) {
  //     args.push(p.type())
  //     if (p.tok == token.COMMA) {
  //       p.next() // consume optional comma
  //     } else {
  //       // end of type def
  //       if (p.tok == token.SHR) {
  //         // convert token ">>" to ">", effectively creating the appearance
  //         // that there are a token ">" followed by a token ">".
  //         // This happens because the scanner is unable to distinguish between
  //         // ">>" and ">".
  //         p.tok = token.GTR
  //       } else {
  //         if (p.tok as token != token.GTR) {
  //           p.syntaxError(`expecting comma or >`)
  //           p.advanceUntil(token.GTR)
  //         }
  //         p.next() // consume ">"
  //       }
  //       break
  //     }
  //   }
  //   return p.types.getGenericInstance(t, args)
  // }


  // IdentifierList = identifier { "," identifier } .
  // The first identifier must be provided.
  identList(first :Ident) :Ident[] {
    const p = this
    const l = [first]
    while (p.got(token.COMMA)) {
      l.push(p.ident())
    }
    return l
  }

  ident() :Ident {
    const p = this
    const pos = p.pos
    if (p.tok == token.NAME) {
      const s = strings.get(p.takeByteValue(), p.hash)
      p.next()
      return new Ident(pos, p.scope, s)
    }
    p.syntaxError("expecting identifier", pos)
    p.advanceUntil()
    return new Ident(pos, p.scope, str__)
  }

  maybeIdent() :Ident|null {
    const p = this
    return (p.tok == token.NAME) ? p.ident() : null
  }

  fallbackIdent(pos? :Pos) :Ident {
    const p = this
    return new Ident(pos || p.pos, p.scope, str__)
  }

  // osemi parses an optional semicolon.
  osemi(follow :token) :bool {
    const p = this

    switch (p.tok) {
      case token.SEMICOLON:
        p.next()
        return true

      case token.RPAREN:
      case token.RBRACE:
        // semicolon is optional before ) or }
        return true
    }

    p.syntaxError("expecting semicolon, newline, or " + tokstr(follow))
    p.advanceUntil(follow)
    return false
  }

  // ocomma parses an optional comma.
  //
  // Note: If you are looking for optionally parsing a comma, without
  // error reporting, then simply the following would be enough:
  //
  //   if (p.tok == token.COMMA) {
  //     p.next()
  //   }
  //
  ocomma(follow :token) :bool {
    const p = this

    switch (p.tok) {
      case token.COMMA:
        p.next()
        return true

      case token.RPAREN:
      case token.RBRACE:
        // comma is optional before ) or }
        return true
    }

    p.syntaxError("expecting comma, or " + tokstr(follow))
    p.advanceUntil(follow)
    return false
  }

  // appendGroup(f) = f | "(" { f ";" } ")" .
  appendGroup<D extends Decl>(list :D[], f :(g:Object|null, i:int)=>D) {
    const p = this
    let i = 0
    if (p.got(token.LPAREN)) {
      const g = new Group()
      while (p.tok != token.EOF && p.tok != token.RPAREN) {
        list.push(f(g, i++))
        if (!p.osemi(token.RPAREN)) {
          break
        }
      }
      p.want(token.RPAREN)
    } else {
      list.push(f(null, i))
    }
  }


  // tryWithBacktracking takes two or more functions which represents
  // different possiblities, or branches, of ambiguous syntax which requires
  // backtracking. In case one function fails to parse, then the parser
  // "backtracks" to where it started and tries the next function.
  //
  // The following steps are performed, starting with the first function:
  //
  //   1. Record a snapshot of the scanner state
  //   2. If this is the last function, simply call the function and
  //      return its value, else...
  //   3. wrap the function call in a try-catch block
  //   4. Setup the syntax error handler to throw an error instead of
  //      reporting errors.
  //   5. Call the function and return its value
  //      - If the function executed without throwing an exception, then
  //        its return value is returned from this function and we are done.
  //      - If a SyntaxError was thrown, advance to the next function and
  //        continue with step 1.
  //      - Any other error thrown will propagate.
  //
  tryWithBacktracking<R>(...f :(()=>R)[]) :R {
    // make sure syntax errors cause exceptions
    let origRaiseOnSyntaxError = this.throwOnSyntaxError
    this.throwOnSyntaxError = true
    let s = this.allocSnapshot()
    let i = 0
    try {
      this.recordSnapshot(s)
      while (i < f.length-1) {
        try {
          return f[i]()
        } catch (e) {
          if (!(e instanceof SyntaxError)) { throw e }
          // fall through and try next function
        }
        i++
        this.restoreSnapshot(s)
      }
    } finally {
      // restore throwOnSyntaxError and free snapshot
      this.throwOnSyntaxError = origRaiseOnSyntaxError
      this.freeSnapshot(s)
    }
    // last function is called without a "harness"
    return f[i]()
  }


  // advanceUntil consumes tokens until it finds a token of the followlist.
  // The stopset is only considered if we are inside a function (p.fnest > 0).
  // The followlist is the list of valid tokens that can follow a production;
  // if it is empty, exactly one token is consumed to ensure progress.
  //
  // Not speed critical, advance is only called in error situations.
  //
  advanceUntil(...followlist :token[]) {
    const p = this

    if (followlist.length == 0) {
      p.next()
      return
    }

    // TODO: improve performance of this, especially followlist.includes

    if (p.fnest > 0) {
      // The stopset contains keywords that start a statement.
      // They are good synchronization points in case of syntax
      // errors and (usually) shouldn't be skipped over.
      loop1:
      while (!followlist.includes(p.tok)) {
        switch (p.tok) {
          case token.EOF:
          case token.BREAK:
          // case token.CONST:
          case token.CONTINUE:
          case token.DEFER:
          case token.FALLTHROUGH:
          case token.FOR:
          case token.FUN:
          case token.GO:
          // case token.GOTO:
          case token.IF:
          case token.RETURN:
          case token.SELECT:
          case token.SWITCH:
          case token.TYPE:
            break loop1
        }
        p.next()
      }
    } else {
      while (!(p.tok == token.EOF || followlist.includes(p.tok))) {
        p.next()
      }
    }
  }

  // syntaxError reports a syntax error
  // If a BadExpr then no error was reported and backtracking should follow,
  // by the caller to this function returning the BadExpr object.
  //
  syntaxError(msg :string, pos :Pos = this.pos) :void {
    const p = this

    if (p.throwOnSyntaxError) {
      throw new SyntaxError(msg, pos)
    }

    let position = p.sfile.position(pos)

    // if (p.tok == token.EOF) {
    //   return // avoid meaningless follow-up errors
    // }

    // add punctuation etc. as needed to msg
    if (msg == "") {
      // msg is empty; ok
    } else if (
      msg.startsWith("in ") ||
      msg.startsWith("at ") ||
      msg.startsWith("after ") ||
      msg.startsWith("expecting ")
    ) {
      msg = " " + msg
    } else {
      // plain error - we don't care about current token
      p.errorAt(msg, position)
      return
    }

    let cond = (
      p.tok == token.EOF ? 'unexpected end of input' :
      `unexpected ${tokstr(p.tok)}`
    )
    p.errorAt(cond + msg, position)
    if (DEBUG) {
      // print token state when compiled in debug mode
      console.error(`  p.tok = ${token[p.tok]} ${tokstr(p.tok)}`)
    }
  }

  // diag reports a diagnostic message, or an error if k is ERROR
  //
  diag(k :DiagKind, msg :string, pos :Pos = this.pos, code? :ErrorCode) {
    const p = this
    // if (code !== undefined) {
    //   // level overridden?
    //   k = p.diagConfig[code] || k
    // }
    if (k == "error") {
      p.error(msg, pos, code)
    } else if (p.diagh) {
      p.diagh(p.sfile.position(pos), msg, k)
    }
  }

}

// unparen removes all parentheses around an expression.
// function unparen(x :Expr) :Expr {
//   while (x instanceof ParenExpr) {
//     x = x.x
//   }
//   return x
// }

function isEmptyFunExpr(d :Decl) :bool {
  return d instanceof FunExpr && !d.body
}
