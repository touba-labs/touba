export async function decide(request) {
  return {
    action: "answer_directly",
    result: "Review recorded: " + request.inputs.incident,
  };
}
