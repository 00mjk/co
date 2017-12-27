// import { token } from './token'
import { SrcFileSet, Pos, Position } from './pos'
import { ErrorHandler } from './scanner'
import { File, Package, Obj, ImportDecl } from './ast'
import * as utf8 from './utf8'


// An Importer resolves import paths to package Objects.
// The imports map records the packages already imported,
// indexed by package id (canonical import path).
// An Importer must determine the canonical import path and
// check the map to see if it is already present in the imports map.
// If so, the Importer can return the map entry. Otherwise, the
// Importer should load the package data for the given path into
// a new *Object (pkg), record pkg in the imports map, and then
// return pkg.
//
export type Importer =
  (imports :Map<string,Obj>, path :string) => Promise<Obj>


// type Importer func(imports map[string]*Object, path string) (pkg :Obj, err :Error)


class binder {
  errorCount = 0
  // package global mapping of imported package ids to package objects
  imports = new Map<string,Obj>()

  constructor(
    public pkg      :Package,
    public fset     :SrcFileSet,
    public files    :File[],
    public importer :Importer|null,
    public errh     :ErrorHandler|null,
  ) {}

  bind() :Promise<void> {
    const b = this

    // complete file scopes with imports and resolve identifiers
    return Promise.all(b.files.map(f => this.resolveImports(f))).then(() => {
      // stop if any imports failed
      if (b.errorCount > 0) {
        return
      }

      // resolve identifiers in files
      for (let f of b.files) {
        b.resolve(f)
      }
    })
  }

  resolveImports(f :File) :Promise<void> {
    const b = this

    if (!f.imports || f.imports.length == 0) {
      return Promise.resolve()
    }

    const pv :Promise<void>[] = []

    for (let decl of f.imports) {
      if (!b.importer) {
        b.error(`unresolvable import ${decl.path}`, decl.path.pos)
        break
      }
      const path = utf8.decodeToString(decl.path.value)
      pv.push(b.importer(b.imports, path)
        .then((pkg :Obj) => { b.integrateImport(f, decl, pkg) })
        .catch(err => {
          b.error(
            `could not import ${path} (${err.message || err})`,
            decl.path.pos
          )
        })
      )
    }
    return Promise.all(pv).then(() => {})
  }

  integrateImport(f :File, imp :ImportDecl, pkg :Obj) {
    // local name overrides imported package name
    let name = imp.localIdent ? imp.localIdent.value : pkg.name

    if (name.toString() == ".") { // TODO: fix efficiency
      // TODO: merge imported scope with file scope
      // for _, obj := range pkg.Data.(*Scope).Objects {
      //   p.declare(fileScope, pkgScope, obj)
      // }
    } else if (name.toString() != "_") { // TODO: fix efficiency
      // declare imported package object in file scope
      // (do not re-use pkg in the file scope but create
      // a new object instead; the Decl field is different
      // for different files)
      const obj = new Obj(name, imp, null, pkg.data)
      f.scope.declareObj(obj)
    }
  }

  resolve(f :File) {
    const b = this

    for (let id of f.unresolved) {
      // see if the name was declared after it was referenced in the file, or
      // declared in another file in the same package
      let obj = f.scope.lookup(id.value)
      if (obj) {
        // if (obj.decl instanceof VarDecl) {
        console.log(`[bind] resolved ${id}`, id)
        id.obj = obj
        continue
      }

      // truly undefined
      b.error(`${id} undefined`, id.pos)
    }
  }

  error(msg :string, pos :Pos, typ? :string) {
    const b = this
    b.errorAt(msg, b.fset.position(pos), typ)
  }

  errorAt(msg :string, position :Position, typ :string = 'E_BIND') {
    const b = this
    if (b.errh) {
      b.errh(position, msg, typ)
    }
    b.errorCount++
  }
}


// bindpkg resolves any undefined names (usually across source files) and,
// unless there are errors, all identifiers in the package will have Ident.obj
// set, pointing to whatever object a name references.
//
// Returns false if there were errors
//
export function bindpkg(
  pkg :Package,
  fset :SrcFileSet,
  files :File[],
  importer :Importer|null,
  errh :ErrorHandler,
) :Promise<bool> {
  const b = new binder(pkg, fset, files, importer, errh)
  return b.bind().then(() => b.errorCount != 0)
}
