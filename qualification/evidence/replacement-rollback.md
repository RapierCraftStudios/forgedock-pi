# Disposable candidate replacement and rollback

A clean disposable Pi config registered the original same-repository Git ref,
replaced it with candidate commit `2f6c4a4b7e874cc5b6b12858acb0f6bcc80c1603`,
then rolled back. The result recorded `replaced` followed by `rolled-back`,
restored the original source ref, and preserved unrelated settings.

- Disposable root: `/tmp/forgedock-git-ref-replacement-2f6`
- Original: `git:github.com/RapierCraftStudios/forgedock-pi@c6bf7ed7a56fd66935f04384ce1b43b8cdf17db7`
- Candidate: `git:github.com/RapierCraftStudios/forgedock-pi@2f6c4a4b7e874cc5b6b12858acb0f6bcc80c1603`
- GitHub writes: none
