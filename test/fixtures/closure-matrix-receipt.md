### Closure Matrix
- primary-caller | producer=emit → consumer=primary-caller | dependency=strict-verifier | state=fresh | counterexample=primary rejects invalid input
- alternate-caller | producer=emit → consumer=alternate-caller | dependency=strict-verifier | state=existing | counterexample=alternate caller rejects strict verifier
- transitive-dependency | producer=emit → consumer=primary-caller | dependency=versioned-verifier | state=fresh | counterexample=imported verifier version changes acceptance
