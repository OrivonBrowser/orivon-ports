// HOW-TO-OPEN.txt, the second file of every encrypted share. The same bytes for every share: it names no address,
// no date and nobody, so that it says nothing about the share it sits in.

export const HOW_TO_OPEN = `This is a protected share made with Orivon Share.

It holds one encrypted file, share.age, and this note.

To open it with the link you were sent: open the link in a web browser and
type the password.

To open it without Orivon Share, with any program that reads the age file
format (https://age-encryption.org):

    age -d -o share.zip share.age

The age program asks for the password. Then open share.zip with any program
that reads ZIP archives. Inside are the files that were shared, and a small
file called .orivon-share.json that describes the share.

Nothing here depends on Orivon Share continuing to exist: share.age is a
standard age file (a passphrase, scrypt work factor 18) that holds a standard
ZIP archive.
`
