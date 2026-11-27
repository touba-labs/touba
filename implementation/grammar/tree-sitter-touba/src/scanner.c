#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
  INDENT_ERROR,
};

enum {
  MAX_INDENTS = 64,
  INDENT_WIDTH = 4,
};

typedef struct {
  uint16_t indents[MAX_INDENTS];
  uint8_t indent_count;
  uint8_t pending_dedents;
  bool pending_indent;
  bool pending_error;
} Scanner;

static void reset_scanner(Scanner *scanner) {
  memset(scanner, 0, sizeof(Scanner));
  scanner->indents[0] = 0;
  scanner->indent_count = 1;
}

void *tree_sitter_touba_external_scanner_create(void) {
  Scanner *scanner = ts_malloc(sizeof(Scanner));
  reset_scanner(scanner);
  return scanner;
}

void tree_sitter_touba_external_scanner_destroy(void *payload) {
  ts_free(payload);
}

unsigned tree_sitter_touba_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = payload;
  unsigned size = 0;
  buffer[size++] = (char)scanner->indent_count;
  buffer[size++] = (char)scanner->pending_dedents;
  buffer[size++] = scanner->pending_indent ? 1 : 0;
  buffer[size++] = scanner->pending_error ? 1 : 0;

  for (uint8_t i = 0; i < scanner->indent_count; i++) {
    uint16_t value = scanner->indents[i];
    buffer[size++] = (char)(value & 0xff);
    buffer[size++] = (char)((value >> 8) & 0xff);
  }

  return size;
}

void tree_sitter_touba_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *scanner = payload;
  reset_scanner(scanner);

  if (length < 4) {
    return;
  }

  uint8_t indent_count = (uint8_t)buffer[0];
  if (indent_count == 0 || indent_count > MAX_INDENTS || length < 4 + (unsigned)indent_count * 2) {
    return;
  }

  scanner->indent_count = indent_count;
  scanner->pending_dedents = (uint8_t)buffer[1];
  scanner->pending_indent = buffer[2] != 0;
  scanner->pending_error = buffer[3] != 0;

  unsigned offset = 4;
  for (uint8_t i = 0; i < indent_count; i++) {
    uint16_t low = (uint8_t)buffer[offset++];
    uint16_t high = (uint8_t)buffer[offset++];
    scanner->indents[i] = (uint16_t)(low | (high << 8));
  }

  if (scanner->indents[0] != 0) {
    reset_scanner(scanner);
  }
}

static void skip_line(TSLexer *lexer) {
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    lexer->advance(lexer, false);
  }
}

static int find_indent(Scanner *scanner, uint32_t indent) {
  for (uint8_t i = 0; i < scanner->indent_count; i++) {
    if (scanner->indents[i] == indent) {
      return i;
    }
  }
  return -1;
}

static void update_indent(Scanner *scanner, uint32_t indent) {
  uint16_t top = scanner->indents[scanner->indent_count - 1];

  if (indent > top) {
    if (indent == (uint32_t)top + INDENT_WIDTH && scanner->indent_count < MAX_INDENTS) {
      scanner->indents[scanner->indent_count++] = (uint16_t)indent;
      scanner->pending_indent = true;
    } else {
      scanner->pending_error = true;
    }
    return;
  }

  if (indent < top) {
    int index = find_indent(scanner, indent);
    if (index >= 0) {
      scanner->pending_dedents = (uint8_t)(scanner->indent_count - (uint8_t)index - 1);
      scanner->indent_count = (uint8_t)index + 1;
    } else {
      scanner->pending_error = true;
    }
  }
}

static bool scan_newline(Scanner *scanner, TSLexer *lexer) {
  bool trailing_space = false;
  while (lexer->lookahead == ' ') {
    trailing_space = true;
    lexer->advance(lexer, true);
  }
  if (trailing_space && lexer->eof(lexer)) {
    update_indent(scanner, 0);
    lexer->result_symbol = NEWLINE;
    return true;
  }
  if (lexer->lookahead != '\n' && lexer->lookahead != '\r') {
    return false;
  }

  uint32_t indent = 0;

  for (;;) {
    while (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      // Consume CR only as part of CRLF. Keeping the original source bytes
      // preserves compiler/LSP locations; a lone CR is still a syntax error.
      if (lexer->lookahead == '\r') {
        lexer->advance(lexer, true);
        if (lexer->lookahead != '\n') {
          return false;
        }
      }
      lexer->advance(lexer, true);
      indent = 0;
    }

    bool has_tab = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      has_tab = has_tab || lexer->lookahead == '\t';
      lexer->advance(lexer, true);
      indent++;
    }

    // Whitespace-only lines have no indentation semantics, including at EOF.
    // Keep their bytes in the source so subsequent locations remain exact.
    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      continue;
    }
    if (lexer->eof(lexer)) {
      break;
    }
    if (has_tab) {
      scanner->pending_error = true;
      break;
    }

    if (lexer->lookahead == '#') {
      while (!lexer->eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
        lexer->advance(lexer, true);
      }
      if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
        continue;
      }
    }

    break;
  }

  if (!scanner->pending_error) {
    update_indent(scanner, lexer->eof(lexer) ? 0 : indent);
  }

  lexer->result_symbol = NEWLINE;
  return true;
}

bool tree_sitter_touba_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  Scanner *scanner = payload;

  if (scanner->pending_error && valid_symbols[INDENT_ERROR]) {
    scanner->pending_error = false;
    skip_line(lexer);
    lexer->result_symbol = INDENT_ERROR;
    return true;
  }

  if (scanner->pending_indent && valid_symbols[INDENT]) {
    scanner->pending_indent = false;
    lexer->result_symbol = INDENT;
    return true;
  }

  if (scanner->pending_dedents > 0 && valid_symbols[DEDENT]) {
    scanner->pending_dedents--;
    lexer->result_symbol = DEDENT;
    return true;
  }

  if (valid_symbols[NEWLINE] && (lexer->lookahead == ' ' || lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
    // On malformed CRLF, return false directly so Tree-sitter rewinds the
    // lookahead; do not consume a bare CR through the EOF dedent path below.
    return scan_newline(scanner, lexer);
  }

  if (lexer->eof(lexer) && scanner->indent_count > 1 && valid_symbols[DEDENT]) {
    scanner->indent_count--;
    lexer->result_symbol = DEDENT;
    return true;
  }

  return false;
}
