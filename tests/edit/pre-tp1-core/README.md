# The Edit Core before TP1 (frozen)

`src/edit/core/{project,ops,history,time,anchors,transitions}.js` exactly as
they were at commit `08e5945`, the commit the TP1 work started on (EH-55).
ET-ASM-08 (`tests/edit-assembly.test.js`) loads them as "the previous client"
to prove it refuses a project with a label or a storyboard whole.

They were read with `git show` at test time, which needs the full history: a
CI checkout is one commit deep, so the test failed there. Frozen here instead,
byte for byte (`git show 08e5945:src/edit/core/<file>`). Never edit them.
