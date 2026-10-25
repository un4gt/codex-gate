NotoSansSC-Variable.woff2 is a self-hosted subset of the Noto Sans SC variable
font used by the Figma Make design. The original font was retrieved from
https://static.figma.com/font/NotoSansSC-VF_2 and is licensed under the SIL Open
Font License (see OFL-NotoSansSC.txt).

The subset retains the characters present in frontend/src as of this change,
and all variable weights. Other characters fall back to the system CJK font.
It was generated with fontTools.subset using --flavor=woff2, --name-IDs='*',
--name-languages='*' and a UTF-8 text file containing the source characters.
