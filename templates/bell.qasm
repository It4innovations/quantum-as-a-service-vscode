// Bell state. Use "Run on VLQ" or "Transpile" above, or the play button in the editor title.
OPENQASM 3.0;
include "stdgates.inc";

qubit[2] q;
bit[2] c;

h q[0];
cx q[0], q[1];
c = measure q;
