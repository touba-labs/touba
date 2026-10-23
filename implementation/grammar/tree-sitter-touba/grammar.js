/**
 * @file Initial Tree-sitter grammar for the bounded Touba v0.1 surface.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

export default grammar({
  name: "touba",

  externals: $ => [
    $._newline,
    $._indent,
    $._dedent,
    $.indent_error,
  ],

  extras: $ => [
    $.comment,
  ],

  conflicts: $ => [
    [$.call_statement],
    [$.human_approval_statement],
    [$.user_interaction_statement],
  ],

  word: $ => $.value_identifier,

  rules: {
    source_file: $ => seq(
      repeat($._newline),
      repeat(seq(
        choice(
          $.module_declaration,
          $.import_declaration,
          $.run_limits_declaration,
          $.define_declaration,
          $.memory_declaration,
          $.type_declaration,
          $.enum_declaration,
          $.function_declaration,
          $.tool_declaration,
          $.skill_declaration,
          $.agent_declaration,
          $.strategy_declaration,
          $.trigger_declaration,
          $.indent_error,
        ),
        repeat($._newline),
      )),
    ),

    module_declaration: $ => seq("module", $._sp, field("name", $.module_name)),

    import_declaration: $ => seq(
      "import",
      $._sp,
      field("kind", $.value_identifier),
      $._sp,
      field("name", $.symbol_identifier),
      $._sp,
      "from",
      $._sp,
      field("from_module", $.module_name),
    ),

    run_limits_declaration: $ => seq(
      "limits", $._sp, "run",
      indentedBlock($, $.run_limit_clause),
    ),

    run_limit_clause: $ => seq(
      field("name", $.value_identifier), $._sp, "as", $._sp,
      field("value", $.expression),
    ),

    define_declaration: $ => seq(
      "define",
      $._sp,
      field("name", $.symbol_identifier),
      $._sp,
      "as",
      $._sp,
      field("type", $.type_ref),
      $._sp,
      "=",
      $._sp,
      field("value", $.expression),
    ),

    memory_declaration: $ => seq(
      "memory",
      $._sp,
      field("name", $.symbol_identifier),
    ),

    type_declaration: $ => seq(
      "type",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, $.field_declaration),
    ),

    field_declaration: $ => seq(
      field("name", $.value_identifier),
      $._sp,
      choice("is", "are"),
      $._sp,
      field("type", $.type_ref),
      repeat(seq($._sp, $.field_constraint)),
      optional(seq($._sp, "default", $._sp, field("default", $.expression))),
    ),

    field_constraint: $ => choice(
      seq(field("kind", "format"), $._sp, field("value", $.string)),
      seq(field("kind", "length"), $._sp, field("value", $.integer), optional(seq("..", field("upper", $.integer)))),
      seq(field("kind", choice("min", "max")), $._sp, field("value", choice($.float, $.integer))),
    ),

    enum_declaration: $ => seq(
      "enum", $._sp, field("name", $.symbol_identifier),
      indentedBlock($, $.enum_variant),
    ),

    enum_variant: $ => field("name", $.value_identifier),

    function_declaration: $ => seq(
      "function",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, choice(
        $.description_clause,
        $.takes_clause,
        $.gives_clause,
        $.do_block,
        $.indent_error,
      )),
    ),

    tool_declaration: $ => seq(
      "tool",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, choice(
        $.description_clause,
        $.takes_clause,
        $.gives_clause,
        $.tool_memory_access_clause,
        $.requires_clause,
        $.secrets_clause,
        $.indent_error,
      )),
    ),

    skill_declaration: $ => seq(
      "skill",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, choice(
        $.description_clause,
        $.takes_clause,
        $.gives_clause,
        $.uses_clause,
        $.memory_scope_clause,
        $.do_block,
        $.on_failure_clause,
        $.indent_error,
      )),
    ),

    agent_declaration: $ => seq(
      "agent",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, choice(
        $.description_clause,
        $.takes_clause,
        $.gives_clause,
        $.responsibility_clause,
        $.uses_clause,
        $.callable_by_clause,
        $.memory_scope_clause,
        $.indent_error,
      )),
    ),

    strategy_declaration: $ => seq(
      "strategy",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, choice(
        $.description_clause,
        $.takes_clause,
        $.gives_clause,
        $.uses_clause,
        $.memory_scope_clause,
        $.do_block,
        $.indent_error,
      )),
    ),

    trigger_declaration: $ => seq(
      "trigger",
      $._sp,
      field("name", $.symbol_identifier),
      indentedBlock($, choice(
        $.trigger_on_clause,
        $.trigger_runs_clause,
        $.call_argument_clause,
        $.trigger_limits_block,
        $.indent_error,
      )),
    ),

    trigger_on_clause: $ => seq(
      "on",
      $._sp,
      field("kind", $.value_identifier),
      optional(seq($._sp, field("detail", $.trigger_event_detail))),
      $._sp,
      field("value", $.string),
    ),

    trigger_runs_clause: $ => seq(
      "runs",
      $._sp,
      field("target_kind", $.value_identifier),
      $._sp,
      field("target", $.symbol_identifier),
    ),

    trigger_limits_block: $ => seq(
      "limits",
      indentedBlock($, choice(
        $.trigger_limit_clause,
        $.indent_error,
      )),
    ),

    trigger_limit_clause: $ => seq(
      field("name", $.value_identifier),
      $._sp,
      "as",
      $._sp,
      field("value", $.expression),
    ),

    takes_clause: $ => seq(
      "takes",
      $._sp,
      commaSep1($.parameter, $),
    ),

    parameter: $ => seq(
      field("name", $.value_identifier),
      $._sp,
      "as",
      $._sp,
      field("type", $.type_ref),
    ),

    gives_clause: $ => seq("gives", $._sp, field("type", $.type_ref)),

    description_clause: $ => seq("description", $._sp, field("value", $.string)),

    responsibility_clause: $ => seq("responsibility", $._sp, field("value", $.string)),

    requires_clause: $ => seq("requires", $._sp, commaSep1($.value_identifier, $)),

    secrets_clause: $ => seq("secrets", $._sp, commaSep1($.secret_identifier, $)),

    uses_clause: $ => seq("uses", $._sp, field("target", $.symbol_identifier)),

    tool_memory_access_clause: $ => seq(
      "uses",
      $._sp,
      "memory",
      $._sp,
      field("memory", $.symbol_identifier),
      $._sp,
      field("access", $.value_identifier),
    ),

    memory_scope_clause: $ => seq(
      "memory",
      $._sp,
      field("memory", $.symbol_identifier),
      $._sp,
      field("access", $.value_identifier),
    ),

    callable_by_clause: $ => seq(
      "callable_by",
      $._sp,
      field("caller_kind", $.value_identifier),
      $._sp,
      field("caller", $.qualified_symbol_identifier),
    ),

    do_block: $ => seq(
      "do",
      indentedBlock($, $._statement),
    ),

    on_failure_clause: $ => seq(
      "on",
      $._sp,
      "failure",
      $._sp,
      field("family", $.failure_family),
      indentedBlock($, choice(
        $.fallback_statement,
        $.stop_statement,
        $.indent_error,
      )),
    ),

    failure_family: _ => token(choice("business", "authority", "provider", "handler")),

    _statement: $ => choice(
      $.bind_statement,
      $.human_approval_statement,
      $.user_interaction_statement,
      $.call_statement,
      $.parallel_statement,
      $.give_statement,
      $.stop_statement,
      $.if_statement,
      $.match_statement,
      $.for_statement,
      $.while_statement,
      $.indent_error,
    ),

    parallel_statement: $ => seq(
      "parallel", $._sp, field("target", $.symbol_identifier),
      indentedBlock($, choice($.parallel_each_clause, $.call_argument_clause,
        $.parallel_limit_clause, $.call_result_binding_clause, $.indent_error)),
    ),

    parallel_each_clause: $ => seq(
      "each", $._sp, field("item", $.value_identifier), $._sp, "in", $._sp,
      field("collection", $.expression),
    ),

    parallel_limit_clause: $ => seq(
      field("name", choice("max_concurrency", "max_items")), $._sp,
      field("value", $.integer),
    ),

    call_statement: $ => seq(
      field("target", $.symbol_identifier),
      optional(indentedBlock($, choice(
        $.call_argument_clause,
        $.call_result_binding_clause,
        $.indent_error,
      ))),
    ),

    human_approval_statement: $ => seq(
      field("target", $.human_approval_target),
      optional(indentedBlock($, choice(
        $.call_argument_clause,
        $.call_result_binding_clause,
        $.approval_expired_clause,
        $.approval_rejected_clause,
        $.indent_error,
      ))),
    ),

    approval_expired_clause: $ => seq("on", $._sp, "expired", indentedBlock($, $._statement)),
    approval_rejected_clause: $ => seq("on", $._sp, "rejected", indentedBlock($, $._statement)),

    human_approval_target: _ => token(choice("human.approve", "human.review")),

    user_interaction_statement: $ => seq(
      field("target", $.user_interaction_target),
      optional(indentedBlock($, choice(
        $.call_argument_clause,
        $.call_result_binding_clause,
        $.indent_error,
      ))),
    ),

    user_interaction_target: _ => token(choice("show", "ask")),

    call_argument_clause: $ => seq(
      "with",
      $._sp,
      field("name", $.value_identifier),
      $._sp,
      "as",
      $._sp,
      field("value", $.expression),
    ),

    call_result_binding_clause: $ => seq(
      "into",
      $._sp,
      field("binding", $.value_identifier),
    ),

    bind_statement: $ => seq(
      "bind",
      $._sp,
      field("name", $.value_identifier),
      $._sp,
      "as",
      $._sp,
      field("type", $.type_ref),
      $._sp,
      "=",
      $._sp,
      field("value", $.expression),
    ),

    give_statement: $ => seq("give", optional(seq($._sp, $.expression))),

    stop_statement: $ => "stop",

    fallback_statement: $ => seq("fallback", $._sp, field("target", $.symbol_identifier)),

    if_statement: $ => prec.right(seq(
      "if",
      $._sp,
      field("condition", choice($.present_condition, $.expression)),
      $.block,
      optional(seq("else", choice($.block, seq($._sp, $.if_statement)))),
    )),

    present_condition: $ => seq("present", $._sp, field("value", $.expression),
      $._sp, "as", $._sp, field("binding", $.value_identifier)),

    match_statement: $ => seq("match", $._sp, field("value", $.expression),
      indentedBlock($, $.match_case)),

    match_case: $ => seq("case", $._sp, field("type", $.symbol_identifier),
      ".", field("variant", $.value_identifier), $.block),

    for_statement: $ => seq(
      "for",
      $._sp,
      field("item", $.value_identifier),
      $._sp,
      "in",
      $._sp,
      field("collection", $.expression),
      $.block,
    ),

    while_statement: $ => seq(
      "while",
      $._sp,
      field("condition", $.expression),
      $.block,
    ),

    block: $ => indentedBlock($, $._statement),

    expression: $ => $._or_expression,

    _or_expression: $ => choice(
      $.or_expression,
      $._and_expression,
    ),

    or_expression: $ => prec.left(seq(
      field("left", $._or_expression),
      field("operator", $.or_operator),
      field("right", $._and_expression),
    )),

    _and_expression: $ => choice(
      $.and_expression,
      $._comparison_expression,
    ),

    and_expression: $ => prec.left(seq(
      field("left", $._and_expression),
      field("operator", $.and_operator),
      field("right", $._comparison_expression),
    )),

    _comparison_expression: $ => choice(
      $.comparison_expression,
      $._additive_expression,
    ),

    comparison_expression: $ => prec.left(seq(
      field("left", $._additive_expression),
      field("operator", $.comparison_operator),
      field("right", $._additive_expression),
    )),

    _additive_expression: $ => choice(
      $.additive_expression,
      $._multiplicative_expression,
    ),

    additive_expression: $ => prec.left(seq(
      field("left", $._additive_expression),
      field("operator", $.additive_operator),
      field("right", $._multiplicative_expression),
    )),

    _multiplicative_expression: $ => choice(
      $.multiplicative_expression,
      $._unary_expression,
    ),

    multiplicative_expression: $ => prec.left(seq(
      field("left", $._multiplicative_expression),
      field("operator", $.multiplicative_operator),
      field("right", $._unary_expression),
    )),

    _unary_expression: $ => choice(
      $.unary_expression,
      $._field_expression,
    ),

    unary_expression: $ => prec.right(seq(
      field("operator", $.not_operator),
      field("operand", $._unary_expression),
    )),

    _field_expression: $ => choice(
      $.field_expression,
      $._primary_expression,
    ),

    field_expression: $ => prec.left(seq(
      field("target", $._field_expression),
      ".",
      field("field", $.value_identifier),
    )),

    _primary_expression: $ => choice(
      $.list_comprehension_expression,
      $.list_concat_expression,
      $.text_join_expression,
      $.list_expression,
      $.optional_some_expression,
      $.optional_none_expression,
      $.record_expression,
      $.record_copy_expression,
      $.text_conversion_expression,
      $.date_conversion_expression,
      $.interpolated_string,
      $.parenthesized_expression,
      $.symbol_identifier,
      $.value_identifier,
      $.string,
      $.integer,
      $.float,
      $.boolean,
    ),

    parenthesized_expression: $ => seq(
      "(",
      field("value", $.expression),
      ")",
    ),

    list_expression: $ => seq("[", optional($._sp), optional(commaSep1($.expression, $)), optional($._sp), "]"),

    list_comprehension_expression: $ => seq("[", optional($._sp), field("element", $.expression),
      $._sp, "for", $._sp, field("item", $.value_identifier), $._sp, "in", $._sp,
      field("collection", $.expression), optional(seq($._sp, "if", $._sp, field("condition", $.expression))), optional($._sp), "]"),

    list_concat_expression: $ => seq("concat", optional($._sp), "(", field("left", $.expression),
      ",", optional($._sp), field("right", $.expression), ")"),

    text_join_expression: $ => seq("join", optional($._sp), "(", field("values", $.expression),
      ",", optional($._sp), field("separator", $.expression), ")"),

    record_copy_expression: $ => seq("copy", $._sp, field("base", $.expression), $._sp,
      "{", optional($._sp), commaSep1($.record_field, $), optional($._sp), "}"),

    text_conversion_expression: $ => seq(
      "text",
      optional($._sp),
      "(",
      field("value", $.expression),
      ")",
    ),

    date_conversion_expression: $ => seq("date", optional($._sp), "(", field("value", $.expression), ")"),

    optional_some_expression: $ => seq("some", optional($._sp), "(", field("value", $.expression), ")"),
    optional_none_expression: $ => seq("none", optional($._sp), "(", field("type", $.type_ref), ")"),

    record_expression: $ => seq(
      "record",
      $._sp,
      field("type", $.symbol_identifier),
      optional($._sp),
      "{",
      optional($._sp),
      optional(commaSep1($.record_field, $)),
      optional($._sp),
      "}",
    ),

    record_field: $ => seq(
      field("name", $.value_identifier),
      $._sp,
      "as",
      $._sp,
      field("value", $.expression),
    ),

    type_ref: $ => choice(
      $.symbol_identifier,
      seq("List", $._sp, "of", $._sp, $.type_ref),
      seq("Optional", $._sp, "of", $._sp, $.type_ref),
    ),

    module_name: $ => seq(
      $.value_identifier,
      repeat(seq(".", $.value_identifier)),
    ),

    qualified_symbol_identifier: _ => /(?:[a-z_][A-Za-z0-9_]*\.)*[A-Z][A-Za-z0-9_]*/,

    symbol_identifier: _ => /[A-Z][A-Za-z0-9_]*/,

    value_identifier: _ => /[a-z_][A-Za-z0-9_]*/,

    secret_identifier: _ => /[A-Z][A-Z0-9_]*/,

    trigger_event_detail: _ => /[A-Za-z_][A-Za-z0-9_]*/,

    // Escapes are decoded and validated once by the CST -> AST compiler.
    string: _ => /"([^"\\\n\r]|\\[^\n\r])*"/,

    interpolated_string: $ => seq('f"', repeat(choice(
      $.interpolated_text, $.interpolation,
    )), token.immediate('"')),

    interpolated_text: _ => token.immediate(prec(1, /([^"\\{}\n\r]|\\[^\n\r]|\{\{|\}\})+/)),

    interpolation: $ => seq(token.immediate("{"), field("value", $.expression), "}"),

    integer: _ => /0|[1-9]\d*/,

    float: _ => /(0|[1-9]\d*)\.\d+/,

    boolean: _ => choice("true", "false"),

    or_operator: _ => token(seq(/[ \t]+/, "or", /[ \t]+/)),

    and_operator: _ => token(seq(/[ \t]+/, "and", /[ \t]+/)),

    comparison_operator: _ => token(seq(/[ \t]*/, choice("==", "!=", "<=", ">=", "<", ">"), /[ \t]*/)),

    additive_operator: _ => token(seq(/[ \t]*/, choice("++", "+", "-"), /[ \t]*/)),

    multiplicative_operator: _ => token(seq(/[ \t]*/, choice("*", "/", "//", "%"), /[ \t]*/)),

    not_operator: _ => token(seq("not", /[ \t]+/)),

    comment: _ => token(seq(optional(/ +/), "#", /[^\r\n]*/)),

    _sp: _ => /[ \t]+/,
  },
});

function commaSep1(rule, $) {
  return seq(rule, repeat(seq(",", optional($._sp), rule)));
}

function indentedBlock($, rule) {
  return seq(
    $._newline,
    $._indent,
    repeat1(seq(rule, repeat($._newline))),
    $._dedent,
  );
}
