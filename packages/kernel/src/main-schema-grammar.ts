import { ClayError } from "./errors";

const TABLE_NAME = /^[a-z][a-z0-9_]{0,40}$|^__(?:clay_attachments)$/;
const COLUMN_NAME = /^[a-z_][a-z0-9_]{0,40}$/;
const DECLARED_TYPE = new Set(["TEXT", "INTEGER", "REAL", "BLOB"]);

type Token = { kind: "word" | "identifier" | "punct"; value: string };
export type ClosedMainColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  notnull: boolean;
};

function invalid(): ClayError {
  return new ClayError("E_STATE_DIGEST_INVALID", "main table schema is outside the closed grammar");
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index]!;
    if (character === " " || character === "\t" || character === "\n"
        || character === "\r" || character === "\f") {
      index++;
      continue;
    }
    if (character === "(" || character === ")" || character === "," || character === ";") {
      tokens.push({ kind: "punct", value: character });
      index++;
      continue;
    }
    if (character === '"') {
      let value = "";
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        value += sql[index]!;
        index++;
      }
      if (!closed) throw invalid();
      tokens.push({ kind: "identifier", value });
      continue;
    }
    if (/[A-Za-z0-9_]/.test(character)) {
      let value = character;
      index++;
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index]!)) {
        value += sql[index]!;
        index++;
      }
      tokens.push({ kind: "word", value });
      continue;
    }
    throw invalid();
  }
  return tokens;
}

export function parseClosedMainTableSql(sql: string, expectedTable: string): ClosedMainColumn[] {
  if (!TABLE_NAME.test(expectedTable)) throw invalid();
  const tokens = tokenize(sql);
  let cursor = 0;
  const next = (): Token => {
    const token = tokens[cursor++];
    if (!token) throw invalid();
    return token;
  };
  const word = (expected: string): void => {
    const token = next();
    if (token.kind !== "word" || token.value.toUpperCase() !== expected) throw invalid();
  };
  const punctuation = (expected: string): void => {
    const token = next();
    if (token.kind !== "punct" || token.value !== expected) throw invalid();
  };
  const name = (pattern: RegExp): string => {
    const token = next();
    if ((token.kind !== "word" && token.kind !== "identifier") || !pattern.test(token.value))
      throw invalid();
    return token.value;
  };
  const peekWord = (value: string): boolean => {
    const token = tokens[cursor];
    return token?.kind === "word" && token.value.toUpperCase() === value;
  };

  word("CREATE");
  word("TABLE");
  if (peekWord("IF")) {
    word("IF");
    word("NOT");
    word("EXISTS");
  }
  if (name(TABLE_NAME) !== expectedTable) throw invalid();
  punctuation("(");

  const columns: ClosedMainColumn[] = [];
  const names = new Set<string>();
  while (true) {
    const columnName = name(COLUMN_NAME);
    if (names.has(columnName)) throw invalid();
    names.add(columnName);
    const typeToken = next();
    const type = typeToken.kind === "word" ? typeToken.value.toUpperCase() : "";
    if (!DECLARED_TYPE.has(type)) throw invalid();
    let primaryKey = false;
    let notnull = false;
    while (tokens[cursor]?.kind === "word") {
      if (peekWord("PRIMARY")) {
        if (primaryKey) throw invalid();
        word("PRIMARY");
        word("KEY");
        primaryKey = true;
      } else if (peekWord("NOT")) {
        if (notnull) throw invalid();
        word("NOT");
        word("NULL");
        notnull = true;
      } else {
        throw invalid();
      }
    }
    columns.push({ name: columnName, type, primaryKey, notnull });
    const separator = next();
    if (separator.kind !== "punct") throw invalid();
    if (separator.value === ")") break;
    if (separator.value !== ",") throw invalid();
  }
  if (tokens[cursor]?.kind === "punct" && tokens[cursor]?.value === ";") cursor++;
  if (cursor !== tokens.length || columns.length === 0
      || columns.filter(column => column.primaryKey).length !== 1
      || columns[0]!.name !== "id" || !columns[0]!.primaryKey)
    throw invalid();
  return columns;
}
