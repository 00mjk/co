//
// simple s-expressions parser made for arch rewrite rules DSL,
// but is generic and can be used independently.
// Do remember than changing this requires testing of the generator
// program in the arch directory.
//
const char = (s :string) => s.charCodeAt(0)
const chr = (code :int) => String.fromCharCode(code)

const lparen = char("(")
    , rparen = char(")")
    , lbrack = char("[")
    , rbrack = char("]")
    , lbrace = char("{")
    , rbrace = char("}")
    , lt     = char("<")
    , gt     = char(">")
    , sp     = char(" ")
    , tab    = char("\t")
    , cr     = char("\r")
    , lf     = char("\n")
    , slash  = char("/")
    , bslash = char("\\")
    , pipe   = char("|")
    , squote = char("'")
    , dquote = char('"')
    , ch_r   = char("r")
    , ch_n   = char("n")
    , ch_t   = char("t")

export type Value = Sym|Pre|List|Union

interface IValue {
  line :int  // 1-based
  col  :int  // 1-based
}

export class List extends Array<Value> implements IValue {
  line :int
  col  :int
  constructor(line :int, col :int) {
    super()
    this.line = line
    this.col  = col
  }
  toString() {
    return `(${this.join(" ")})`
  }
}

export class Union extends Array<Sym> implements IValue {
  line   :int
  col    :int
  prefix :string
  constructor(line :int, col :int, prefix :string) {
    super()
    this.line = line
    this.col  = col
    this.prefix = prefix
  }
  toString() {
    return `${this.prefix}(${this.map(s => s.value.substr(this.prefix.length)).join("|")})`
  }
}

export class Sym implements IValue {
  line  :int
  col   :int
  value :string
  constructor(line :int, col :int, value :string) {
    this.line  = line
    this.col   = col
    this.value = value
  }
  toString() { return this.value }
}

export type PreType = "'" | '"' | "<" | "[" | "{"

export class Pre extends Sym {
  type :PreType
  constructor(line :int, col :int, value :string, type :PreType) {
    super(line, col, value)
    this.type  = type
  }
  toString() {
    return (
      this.type == "'" ? `'${this.value}'` :
      this.type == '"' ? `"${this.value}"` :
      this.type == "<" ? `<${this.value}>` :
      this.type == "[" ? `[${this.value}]` :
      this.type == "{" ? `{${this.value}}` :
      this.value
    )
  }
}

export class SyntaxError extends Error {
  line :int
  col  :int
  file :string
}

export function parse(src :string, filename? :string) :List {
  let i = 0
    , c = 0
    , nextc = 0
    , line = 1
    , lineStart = 0
    , symstart = -1

  function readRestOfLine() {
    while (i < src.length) {
      c = src.charCodeAt(i++)
      nextc = src.charCodeAt(i) || 0
      if (c == lf) {
        return
      }
      if (c == cr) {
        if (nextc == lf) {
          // CRLF
          i++
        }
        return
      }
    }
  }

  const newLine = () => {
    lineStart = i
    line++
  }

  const syntaxErr = (msg :string) => {
    let col = i - lineStart
    let file = filename || "<input>"
    let e = new SyntaxError(`${file}:${line}:${col}: ${msg}`)
    e.name = "SyntaxError"
    e.file = file
    e.line = line
    e.col = col
    throw e
  }

  const startSym = () => {
    if (symstart == -1) {
      symstart = i - 1
    }
  }

  function flushSym<T extends Union|List>(dst :T, prefix? :string) {
    if (symstart != -1) {
      let s = src.substring(symstart, i - 1)
      if (prefix) {
        s = prefix + s
      }
      dst.push(new Sym(line, symstart - lineStart + 1, s))
      symstart = -1
      return true
    }
    return false
  }

  const parseUnion = () => {
    let expectingPipe = false
    let startoffs = i
    let prefix = src.substring(symstart, i - 1)
    symstart = -1

    let u = new Union(line, i - lineStart, prefix)

    while_loop: while (i < src.length) {
      c = src.charCodeAt(i++)
      switch (c) {
        case sp:
        case tab:
          if (flushSym(u, prefix)) {
            expectingPipe = true
          }
          break

        case pipe:
          if (!expectingPipe) {
            syntaxErr(`unexpected "|"`)
          }
          flushSym(u, prefix)
          expectingPipe = false
          break

        case rparen:
          if (!flushSym(u, prefix) && !expectingPipe) {
            // case: foo(bar|) => foobar, foo
            u.push(new Sym(line, i - lineStart, prefix))
          }
          break while_loop

        case cr:
        case lf:
        case lbrack:
        case lbrace:
        case rbrack:
        case rbrace:
          syntaxErr(`unexpected ${repr(chr(c))} in union`)
          break

        default:
          if (symstart == -1) {
            if (expectingPipe) {
              syntaxErr(`expected "|" or ")" but found ${repr(chr(c))}`)
            }
            expectingPipe = true
          }
          startSym()
      }
    }
    return u
  }

  const parsePre = (startc :int, endc :int, type :PreType) :Pre => {
    let buf :int[] = []
    let value :string|null = null
    let startindex = i
    let startline = line
    while_loop: while (i < src.length) {
      c = src.charCodeAt(i++)
      switch (c) {
        case bslash:
          switch (c = src.charCodeAt(i++)) {
            case ch_r:   buf.push(cr); break
            case ch_n:   buf.push(lf); break
            case ch_t:   buf.push(tab); break
            case bslash: buf.push(bslash); break

            case startc:
            case endc:
              buf.push(c)
              break

            default:
              syntaxErr(`invalid string escape seq "\\${chr(c)}"`)
          }
          break

        case endc:
          value = String.fromCharCode.apply(String, buf)
          break while_loop

        default:
          buf.push(c)
      }
    }
    if (value === null) {
      syntaxErr(`unterminated string`)
    }
    return new Pre(startline, startindex - lineStart, value as string, type)
  }

  function parseList(endchar :int) :List {
    let list = new List(line, i - lineStart)

    while_loop: while (i < src.length) {
      c = src.charCodeAt(i++)
      nextc = src.charCodeAt(i) || 0
      switch (c) {
        case lparen:
          if (symstart != -1) {
            // expansion e.g. foo(bar|baz) => foobar foobaz
            list.push(parseUnion())
          } else {
            list.push(parseList(rparen))
          }
          break

        case endchar:
          flushSym(list)
          break while_loop

        case rparen:
        case rbrack:
        case rbrace:
          syntaxErr(`unbalanced ${repr(chr(c))}`)
          break

        case slash:
          if (nextc == slash) {
            flushSym(list)
            // let commentStart = ++i
            readRestOfLine()
            // print(`comment: ${repr(src.substring(commentStart, i-1))}`)
            newLine()
          } else {
            startSym()
          }
          break

        case cr:
          flushSym(list)
          if (nextc == lf) {
            // consume LF after CR
            i++
          }
          newLine()
          break

        case sp:
        case tab:
        case lf:
          flushSym(list)
          if (c == lf) {
            newLine()
          }
          break

        case squote: // '...'
          flushSym(list)
          list.push(parsePre(c, squote, "'"))
          break

        case dquote: // "..."
          flushSym(list)
          list.push(parsePre(c, dquote, '"'))
          break

        case lbrack: // [...]
          flushSym(list)
          list.push(parsePre(c, rbrack, "["))
          break

        case lbrace: // {...}
          flushSym(list)
          list.push(parsePre(c, rbrace, "{"))
          break

        case lt: // <...>
          flushSym(list)
          list.push(parsePre(c, gt, "<"))
          break

        default:
          // any other character is part of a token
          startSym()
      }
    }
    return list
  }

  return parseList(0)
}